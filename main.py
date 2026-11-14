#!/usr/bin/env python3
"""A GitHub-compatible git forge in one process, standard library only.

Serves git smart HTTP (upload-pack protocol v2, receive-pack v0), the REST v3
API, the GraphQL v4 API and an MCP endpoint, all over one in-memory store.
The lifecycle matches the contest harness: bind an ephemeral port, register
it with the env, poll until the env says the trial is done, then exit 0.
"""
import hashlib
import json
import os
import sys
import threading
import time
import urllib.request
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ZERO_OID = "0" * 40
TYPE_CODE = {"commit": 1, "tree": 2, "blob": 3, "tag": 4}
CODE_TYPE = {1: "commit", 2: "tree", 3: "blob", 4: "tag"}
PKT_MAX_PAYLOAD = 65520 - 4

ENV_URL = os.environ.get("MAKEFUN_ENV_URL", "").rstrip("/")
SHOP_TOKEN = os.environ.get("MAKEFUN_SHOP_TOKEN", "")


# --------------------------------------------------------------------------
# git object model
# --------------------------------------------------------------------------

def hash_object(type_, data):
    header = ("%s %d\0" % (type_, len(data))).encode()
    return hashlib.sha1(header + data).hexdigest()


def parse_tree(data):
    entries = []
    pos = 0
    while pos < len(data):
        space = data.index(b" ", pos)
        nul = data.index(b"\0", space + 1)
        mode = data[pos:space].decode()
        name = data[space + 1:nul].decode()
        oid = data[nul + 1:nul + 21].hex()
        entries.append((mode, name, oid))
        pos = nul + 21
    return entries


def build_tree(entries):
    def sort_key(entry):
        mode, name, _ = entry
        return (name + "/" if mode == "40000" else name).encode()

    out = bytearray()
    for mode, name, oid in sorted(entries, key=sort_key):
        out += ("%s %s\0" % (mode, name)).encode()
        out += bytes.fromhex(oid)
    return bytes(out)


def parse_commit(data):
    head, _, message = data.partition(b"\n\n")
    tree = None
    parents = []
    author = ""
    committer = ""
    for line in head.decode("utf-8", "replace").split("\n"):
        if line.startswith("tree "):
            tree = line[5:]
        elif line.startswith("parent "):
            parents.append(line[7:])
        elif line.startswith("author "):
            author = line[7:]
        elif line.startswith("committer "):
            committer = line[10:]
    return {"tree": tree, "parents": parents, "author": author,
            "committer": committer, "message": message.decode("utf-8", "replace")}


def build_commit(tree, parents, author, committer, message):
    lines = ["tree " + tree]
    for parent in parents:
        lines.append("parent " + parent)
    lines.append("author " + author)
    lines.append("committer " + committer)
    lines.append("")
    lines.append(message)
    return "\n".join(lines).encode()


def parse_tag(data):
    head, _, message = data.partition(b"\n\n")
    fields = {}
    for line in head.decode("utf-8", "replace").split("\n"):
        key, _, value = line.partition(" ")
        fields[key] = value
    return {"object": fields.get("object", ""), "type": fields.get("type", ""),
            "tag": fields.get("tag", ""), "tagger": fields.get("tagger", ""),
            "message": message.decode("utf-8", "replace")}


def peel_to_commit(store, oid):
    """Follow tag objects until a commit (or a non-tag) is reached."""
    seen = 0
    while True:
        obj = store.get(oid)
        if obj is None or obj[0] != "tag" or seen > 16:
            return oid
        oid = parse_tag(obj[1])["object"]
        seen += 1


# --------------------------------------------------------------------------
# packfiles
# --------------------------------------------------------------------------

def write_pack(objects):
    """objects: list of (type, data). Plain objects only, pack version 2."""
    out = bytearray()
    out += b"PACK" + (2).to_bytes(4, "big") + len(objects).to_bytes(4, "big")
    for type_, data in objects:
        code = TYPE_CODE[type_]
        size = len(data)
        first = (code << 4) | (size & 0x0F)
        size >>= 4
        while size:
            out.append(first | 0x80)
            first = size & 0x7F
            size >>= 7
        out.append(first)
        out += zlib.compress(data)
    out += hashlib.sha1(bytes(out)).digest()
    return bytes(out)


def _read_pack_varint(buf, pos):
    byte = buf[pos]
    first = byte
    size = byte & 0x0F
    shift = 4
    pos += 1
    while byte & 0x80:
        byte = buf[pos]
        pos += 1
        size += (byte & 0x7F) << shift
        shift += 7
    return size, pos, first


def _apply_delta(base, delta):
    pos = 0

    def read_size():
        nonlocal pos
        value = 0
        shift = 0
        while True:
            byte = delta[pos]
            pos += 1
            value += (byte & 0x7F) << shift
            shift += 7
            if not byte & 0x80:
                return value

    source_size = read_size()
    if source_size != len(base):
        raise ValueError("delta base size mismatch")
    target_size = read_size()
    out = bytearray()
    while pos < len(delta):
        op = delta[pos]
        pos += 1
        if op & 0x80:
            copy_off = 0
            copy_size = 0
            for bit in range(4):
                if op & (1 << bit):
                    copy_off += delta[pos] << (8 * bit)
                    pos += 1
            for bit in range(3):
                if op & (0x10 << bit):
                    copy_size += delta[pos] << (8 * bit)
                    pos += 1
            if copy_size == 0:
                copy_size = 0x10000
            out += base[copy_off:copy_off + copy_size]
        elif op:
            out += delta[pos:pos + op]
            pos += op
        else:
            raise ValueError("delta opcode 0")
    if len(out) != target_size:
        raise ValueError("delta target size mismatch")
    return bytes(out)


def read_pack(buf, resolve_external=None):
    """Parse a pack; returns {oid: (type, data)}. Raises ValueError on damage."""
    if len(buf) < 32 or buf[:4] != b"PACK":
        raise ValueError("not a pack")
    version = int.from_bytes(buf[4:8], "big")
    if version not in (2, 3):
        raise ValueError("bad pack version")
    count = int.from_bytes(buf[8:12], "big")
    trailer = buf[-20:]
    if hashlib.sha1(buf[:-20]).digest() != trailer:
        raise ValueError("pack checksum mismatch")
    raw = []  # (offset, typecode, data, base_offset, base_oid)
    by_offset = {}
    pos = 12
    end = len(buf) - 20
    for _ in range(count):
        offset = pos
        size, pos, first = _read_pack_varint(buf, pos)
        typecode = (first >> 4) & 0x07
        base_offset = None
        base_oid = None
        if typecode == 6:
            byte = buf[pos]
            pos += 1
            value = byte & 0x7F
            while byte & 0x80:
                byte = buf[pos]
                pos += 1
                value = ((value + 1) << 7) + (byte & 0x7F)
            base_offset = offset - value
        elif typecode == 7:
            base_oid = buf[pos:pos + 20].hex()
            pos += 20
        decomp = zlib.decompressobj()
        data = decomp.decompress(buf[pos:end])
        if len(data) != size:
            raise ValueError("pack entry size mismatch")
        pos = end - len(decomp.unused_data)
        entry = (offset, typecode, data, base_offset, base_oid)
        raw.append(entry)
        by_offset[offset] = entry
    if pos != end:
        raise ValueError("pack has trailing bytes")
    resolved = {}

    def resolve(entry):
        offset, typecode, data, base_offset, base_oid = entry
        if offset in resolved:
            return resolved[offset]
        if typecode in CODE_TYPE:
            result = (CODE_TYPE[typecode], data)
        elif typecode == 6:
            base = resolve(by_offset[base_offset])
            result = (base[0], _apply_delta(base[1], data))
        else:
            if base_oid in objects:
                base = objects[base_oid]
            elif resolve_external is not None:
                base = resolve_external(base_oid)
                if base is None:
                    raise ValueError("thin pack base missing")
            else:
                raise ValueError("ref-delta base missing")
            result = (base[0], _apply_delta(base[1], data))
        resolved[offset] = result
        return result

    objects = {}
    for entry in raw:
        type_, data = resolve(entry)
        objects[hash_object(type_, data)] = (type_, data)
    return objects


# --------------------------------------------------------------------------
# reachability
# --------------------------------------------------------------------------

def closure(store, roots, depth=None):
    """All object ids reachable from roots. With depth set, commits are
    limited to that many generations (boundary commits included, their
    parents excluded); trees and blobs of included commits are complete."""
    seen = set()
    gens = {}
    stack = []
    for root in roots:
        if root and root != ZERO_OID:
            stack.append((root, 0))
    while stack:
        oid, gen = stack.pop()
        obj = store.get(oid)
        if obj is None:
            continue
        type_, data = obj
        if type_ == "commit":
            if oid in gens and gens[oid] <= gen:
                continue
            gens[oid] = gen
            seen.add(oid)
            parsed = parse_commit(data)
            if parsed["tree"]:
                stack.append((parsed["tree"], gen))
            if depth is None or gen + 1 < depth:
                for parent in parsed["parents"]:
                    stack.append((parent, gen + 1))
            continue
        if oid in seen:
            continue
        seen.add(oid)
        if type_ == "tree":
            for _, _, child in parse_tree(data):
                stack.append((child, gen))
        elif type_ == "tag":
            stack.append((parse_tag(data)["object"], gen))
    return seen


def is_ancestor(store, old, new):
    """True when old is reachable from new through commit parents (or equal)."""
    if old == new:
        return True
    seen = set()
    stack = [new]
    while stack:
        oid = stack.pop()
        if oid == old:
            return True
        if oid in seen:
            continue
        seen.add(oid)
        obj = store.get(oid)
        if obj is None or obj[0] != "commit":
            continue
        stack.extend(parse_commit(obj[1])["parents"])
    return False


# --------------------------------------------------------------------------
# pkt-line
# --------------------------------------------------------------------------

def pkt(payload):
    if isinstance(payload, str):
        payload = payload.encode()
    return ("%04x" % (len(payload) + 4)).encode() + payload


PKT_FLUSH = b"0000"
PKT_DELIM = b"0001"
PKT_RESPONSE_END = b"0002"


def parse_pkt_lines(buf, pos=0):
    """Parse pkt-lines from buf starting at pos. Returns (payloads, end_pos)
    where payloads holds bytes for data packets and the strings 'flush',
    'delim', 'response-end' for control packets. Stops at the first
    incomplete or invalid packet, returning what was parsed."""
    payloads = []
    while pos + 4 <= len(buf):
        header = buf[pos:pos + 4]
        try:
            length = int(header.decode("ascii"), 16)
        except (ValueError, UnicodeDecodeError):
            break
        if length == 0:
            payloads.append("flush")
            pos += 4
            break
        if length == 1:
            payloads.append("delim")
            pos += 4
            continue
        if length == 2:
            payloads.append("response-end")
            pos += 4
            continue
        if length == 3 or length > 65520:
            break
        if pos + length > len(buf):
            break
        payloads.append(buf[pos + 4:pos + length])
        pos += length
    return payloads, pos


# --------------------------------------------------------------------------
# object store + repositories
# --------------------------------------------------------------------------

OBJECTS = {}  # oid -> (type, bytes); content-addressed, shared by all repos
STORE_LOCK = threading.RLock()


def store_object(type_, data):
    oid = hash_object(type_, data)
    with STORE_LOCK:
        OBJECTS[oid] = (type_, data)
    return oid


def get_object(oid):
    return OBJECTS.get(oid)


def read_tree_files(tree_oid, prefix=""):
    """Flatten a tree into {path: (mode, oid)} for blobs and subtrees."""
    out = {}
    entry = get_object(tree_oid)
    if entry is None or entry[0] != "tree":
        return out
    for mode, name, oid in parse_tree(entry[1]):
        path = prefix + name
        if mode == "40000":
            out.update(read_tree_files(oid, path + "/"))
        else:
            out[path] = (mode, oid)
    return out


def build_tree_from_files(files):
    """Build nested tree objects from {path: (mode, blob_oid)}; returns root oid."""
    # group by first path segment
    root_entries = {}
    subdirs = {}
    for path, (mode, oid) in files.items():
        head, sep, rest = path.partition("/")
        if sep:
            subdirs.setdefault(head, {})[rest] = (mode, oid)
        else:
            root_entries[head] = (mode, oid)
    entries = []
    for name, (mode, oid) in root_entries.items():
        entries.append((mode, name, oid))
    for name, sub in subdirs.items():
        entries.append(("40000", name, build_tree_from_files(sub)))
    return store_object("tree", build_tree(entries))


AUTHOR_LINE = "Forge Bot <forge@example.com>"


def make_commit(tree_oid, parents, message, when=None):
    if when is None:
        when = int(time.time())
    stamp = "%d +0000" % when
    data = build_commit(tree_oid, parents,
                        "%s %s" % (AUTHOR_LINE, stamp),
                        "%s %s" % (AUTHOR_LINE, stamp),
                        message)
    return store_object("commit", data)


class Repo:
    _next_id = 1

    def __init__(self, name):
        self.id = Repo._next_id
        Repo._next_id += 1
        self.name = name
        self.owner_login = None  # learned lazily from owner-bearing paths
        self.description = ""
        self.private = False
        self.default_branch = "main"
        self.refs = {}  # full ref name -> oid
        self.head_ref = "refs/heads/main"
        self.issues = {}  # number -> issue dict
        self.pulls = {}  # number -> pull dict (shares the issue number space)
        self.labels = {}  # name -> {"name":..., "color":...}
        self.next_number = 1
        self.created_seq = self.id

    def head_oid(self):
        return self.refs.get(self.head_ref)

    def branch_oid(self, branch):
        return self.refs.get("refs/heads/" + branch)


REPOS = {}  # name -> Repo
OWNER = {"login": None}  # the suite's viewer login, learned lazily
NODE_IDS = {}  # node id -> (kind, repo_name, number_or_None)
NODE_KEYS = {}  # (kind, repo_name, number_or_None) -> node id
NODE_SEQ = [0]


def node_id(kind, repo_name, number=None):
    """Stable global ids: the same object yields the same id on every
    surface (REST, GraphQL, MCP), and ids resolve back through NODE_IDS."""
    key = (kind, repo_name, number)
    existing = NODE_KEYS.get(key)
    if existing is not None:
        return existing
    NODE_SEQ[0] += 1
    raw = "%s:%s:%s:%d" % (kind, repo_name, number if number is not None else 0,
                           NODE_SEQ[0])
    import base64
    nid = base64.b64encode(raw.encode()).decode()
    NODE_IDS[nid] = key
    NODE_KEYS[key] = nid
    return nid


def create_repo(name):
    repo = Repo(name)
    REPOS[name] = repo
    return repo


def find_repo(owner, name):
    """Resolve a repo by owner+name under the single-user owner rules:
    unknown name -> None; once the viewer login is learned, a foreign owner
    on an existing repo -> None (404); otherwise learn the login."""
    repo = REPOS.get(name)
    if repo is None:
        return None
    if owner:
        if OWNER["login"] is None:
            OWNER["login"] = owner
            repo.owner_login = owner
        elif owner != OWNER["login"]:
            return None
    return repo


# --------------------------------------------------------------------------
# HTTP plumbing
# --------------------------------------------------------------------------

REQ_SEQ = [0]


def request_id():
    REQ_SEQ[0] += 1
    return "F%06X" % REQ_SEQ[0]


class ForgeHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "Forge/1.0"

    def setup(self):
        super().setup()
        try:
            import socket
            self.request.setsockopt(socket.IPPROTO_TCP,
                                    socket.TCP_NODELAY, 1)
        except Exception:
            pass

    def log_message(self, fmt, *args):  # keep stdout clean
        pass

    # -- response helpers -------------------------------------------------
    def _send(self, status, body, content_type, extra_headers=None):
        if isinstance(body, str):
            body = body.encode()
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-GitHub-Request-Id", request_id())
        if extra_headers:
            for key, value in extra_headers:
                self.send_header(key, value)
        self.end_headers()
        if body and self.command != "HEAD":
            self.wfile.write(body)

    def send_json(self, status, obj, extra_headers=None):
        self._send(status, json.dumps(obj), "application/json; charset=utf-8",
                    extra_headers)

    def send_error_json(self, status, message):
        self.send_json(status, {"message": message})

    # -- request helpers --------------------------------------------------
    def read_body(self):
        length = self.headers.get("Content-Length")
        if length is None:
            return b""
        try:
            n = int(length)
        except ValueError:
            return b""
        if n <= 0:
            return b""
        return self.rfile.read(n)

    def authorized(self):
        if not SHOP_TOKEN:
            return True
        return self.headers.get("Authorization") == "Bearer " + SHOP_TOKEN

    # -- dispatch -----------------------------------------------------------
    def _dispatch(self, method):
        try:
            body = self.read_body() if method in ("POST", "PUT", "PATCH",
                                                  "DELETE") else b""
            route(self, method, body)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:  # never take the server down on one request
            try:
                self.send_error_json(500, "internal error: %s" % exc)
            except Exception:
                pass

    def do_GET(self):
        self._dispatch("GET")

    def do_POST(self):
        self._dispatch("POST")

    def do_PUT(self):
        self._dispatch("PUT")

    def do_PATCH(self):
        self._dispatch("PATCH")

    def do_DELETE(self):
        self._dispatch("DELETE")


def route(handler, method, body):
    from urllib.parse import urlparse, parse_qs
    parsed = urlparse(handler.path)
    path = parsed.path
    query = {k: v[0] for k, v in parse_qs(parsed.query).items()}

    if path == "/healthz":
        handler.send_json(200, {"status": "ok"})
        return
    if not handler.authorized():
        handler.send_error_json(401, "Bad credentials")
        return

    parts = [p for p in path.split("/") if p != ""]
    result = dispatch(handler, method, parts, path, query, body)
    if result is None:
        handler.send_error_json(404, "Not Found")


def dispatch(handler, method, parts, path, query, body):
    """Filled in by the surface modules below; returns True when handled."""
    return git_dispatch(handler, method, parts, path, query, body) or \
        rest_dispatch(handler, method, parts, path, query, body) or \
        graphql_dispatch(handler, method, parts, path, query, body) or \
        mcp_dispatch(handler, method, parts, path, query, body)


# --------------------------------------------------------------------------
# lifecycle: bind ephemeral port, register with the env, poll /done
# --------------------------------------------------------------------------

def _env_request(method, suffix, payload=None, timeout=30):
    url = ENV_URL + suffix
    data = None
    headers = {}
    if payload is not None:
        data = json.dumps(payload).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.status, resp.read()


def register(port):
    attempt = 0
    while True:
        try:
            status, _ = _env_request("POST", "/register", {"port": port})
            if status in (200, 409):
                return
            if status in (400, 405):
                raise RuntimeError("register answered HTTP %d" % status)
        except RuntimeError:
            raise
        except Exception:
            pass
        time.sleep(min(2.0, 0.25 * (2 ** min(attempt, 8))))
        attempt += 1


def wait_for_done():
    attempt = 0
    while True:
        try:
            status, raw = _env_request("GET", "/done")
            if status == 200 and json.loads(raw.decode()).get("done") is True:
                return
        except Exception:
            pass
        time.sleep(min(2.0, 0.25 * (2 ** min(attempt, 8))))
        attempt += 1


class ForgeServer(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 128  # 50 concurrent clones must not overflow the
    # listen backlog (dropped SYNs cost whole retransmit seconds)

    def handle_error(self, request, client_address):
        pass  # a reset peer is noise, not a server failure


def main():
    if not ENV_URL and not os.environ.get("FORGE_LOCAL_DEV"):
        sys.stderr.write("[entry] MAKEFUN_ENV_URL is not set\n")
        return 1
    server = ForgeServer(("0.0.0.0", 0), ForgeHandler)
    port = server.server_address[1]
    sys.stdout.write("[entry] listening on port %d\n" % port)
    sys.stdout.flush()
    if os.environ.get("FORGE_LOCAL_DEV"):
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        return 0
    serving = threading.Thread(target=server.serve_forever, daemon=True)
    serving.start()
    register(port)
    sys.stdout.write("[entry] registered; waiting for done\n")
    sys.stdout.flush()
    wait_for_done()
    server.shutdown()
    server.server_close()
    sys.stdout.write("[entry] done\n")
    return 0


# --------------------------------------------------------------------------
# git smart HTTP
# --------------------------------------------------------------------------

AGENT = "agent=forge/1.0"
UPLOAD_CAPS_V0 = ("multi_ack_detailed side-band-64k thin-pack ofs-delta "
                  "deepen-since deepen-not symref=HEAD:refs/heads/main " + AGENT)
RECEIVE_CAPS = "report-status delete-refs side-band-64k ofs-delta " + AGENT


def _repo_from_parts(parts):
    """parts: [owner, repo(.git)?, ...] -> Repo or None."""
    if len(parts) < 2:
        return None
    owner, name = parts[0], parts[1]
    if name.endswith(".git"):
        name = name[:-4]
    return find_repo(owner, name)


def _sorted_refs(repo):
    return sorted(repo.refs.items())


def _peel(oid):
    obj = get_object(oid)
    if obj is not None and obj[0] == "tag":
        return peel_to_commit(OBJECTS, oid)
    return None


def _advertise(handler, repo, service):
    version2 = "version=2" in (handler.headers.get("Git-Protocol") or "")
    ctype = "application/x-%s-advertisement" % service
    out = bytearray()
    if service == "git-upload-pack" and version2:
        out += pkt("version 2")
        out += pkt(AGENT)
        out += pkt("ls-refs=unborn")
        out += pkt("fetch=shallow")
        out += pkt("object-format=sha1")
        out += PKT_FLUSH
        handler._send(200, bytes(out), ctype)
        return
    out += pkt("# service=%s\n" % service)
    out += PKT_FLUSH
    caps = UPLOAD_CAPS_V0 if service == "git-upload-pack" else RECEIVE_CAPS
    refs = _sorted_refs(repo)
    head = repo.head_oid()
    if not refs:
        out += pkt("%s capabilities^{}\0%s" % (ZERO_OID, caps))
    else:
        if head:
            out += pkt("%s HEAD\0%s" % (head, caps))
        else:
            out += pkt("%s capabilities^{}\0%s" % (ZERO_OID, caps))
        for name, oid in refs:
            out += pkt("%s %s" % (oid, name))
            peeled = _peel(oid)
            if peeled:
                out += pkt("%s %s^{}" % (peeled, name))
    out += PKT_FLUSH
    handler._send(200, bytes(out), ctype)


def _parse_command(body):
    """Parse a v2 command request: returns (command, caps, args, pack_start)
    where args is a list of raw argument byte-lines after the delim."""
    lines, _ = parse_pkt_lines(body)
    command = None
    caps = []
    args = []
    seen_delim = False
    for line in lines:
        if line == "flush":
            break
        if line == "delim":
            seen_delim = True
            continue
        if not seen_delim:
            text = line.decode("utf-8", "replace").rstrip("\n")
            if text.startswith("command="):
                command = text[len("command="):]
            else:
                caps.append(text)
        else:
            args.append(line)
    return command, caps, args


def _ls_refs(handler, repo, args):
    peel = symrefs = unborn = False
    prefixes = []
    for raw in args:
        text = raw.decode("utf-8", "replace").rstrip("\n")
        if text == "peel":
            peel = True
        elif text == "symrefs":
            symrefs = True
        elif text == "unborn":
            unborn = True
        elif text.startswith("ref-prefix "):
            prefixes.append(text[len("ref-prefix "):])

    def matches(name):
        return not prefixes or any(name.startswith(p) for p in prefixes)

    out = bytearray()
    head = repo.head_oid()
    if matches("HEAD"):
        if head:
            line = "%s HEAD" % head
            if symrefs:
                line += " symref-target:%s" % repo.head_ref
            if peel:
                peeled = _peel(head)
                if peeled:
                    line += " peeled:%s" % peeled
            out += pkt(line)
        elif unborn:
            out += pkt("unborn HEAD symref-target:%s" % repo.head_ref)
    for name, oid in _sorted_refs(repo):
        if not matches(name):
            continue
        line = "%s %s" % (oid, name)
        if peel:
            peeled = _peel(oid)
            if peeled:
                line += " peeled:%s" % peeled
        out += pkt(line)
    out += PKT_FLUSH
    handler._send(200, bytes(out), "application/x-git-upload-pack-result")


def _commit_time(oid):
    obj = get_object(oid)
    if obj is None or obj[0] != "commit":
        return 0
    committer = parse_commit(obj[1]).get("committer", "")
    parts = committer.rsplit(" ", 2)
    try:
        return int(parts[-2])
    except (ValueError, IndexError):
        return 0


def _shallow_walk(wants, deepen, since, not_tips):
    """Commit walk honouring deepen / deepen-since / deepen-not.
    Returns (commit_set, boundary_set)."""
    excluded = set()
    stack = list(not_tips)
    while stack:
        oid = stack.pop()
        if oid in excluded:
            continue
        obj = get_object(oid)
        if obj is None or obj[0] != "commit":
            continue
        excluded.add(oid)
        stack.extend(parse_commit(obj[1])["parents"])
    included = set()
    gens = {}
    stack = []
    for want in wants:
        target = peel_to_commit(OBJECTS, want) if get_object(want) and \
            get_object(want)[0] == "tag" else want
        stack.append((target, 0))
    while stack:
        oid, gen = stack.pop()
        if oid in excluded or oid not in OBJECTS or \
                OBJECTS[oid][0] != "commit":
            continue
        if oid in gens and gens[oid] <= gen:
            continue
        if deepen is not None and gen >= deepen:
            continue
        if since is not None and included and _commit_time(oid) <= since \
                and gen > 0:
            continue
        gens[oid] = gen
        included.add(oid)
        for parent in parse_commit(OBJECTS[oid][1])["parents"]:
            stack.append((parent, gen + 1))
    boundary = set()
    for oid in included:
        for parent in parse_commit(OBJECTS[oid][1])["parents"]:
            if parent not in included and parent in OBJECTS:
                boundary.add(oid)
                break
    return included, boundary


PACK_CACHE = {}
PACK_CACHE_LOCK = threading.Lock()
PACK_COMPUTE_LOCK = threading.Lock()


def _compute_pack(repo, wants, haves, client_shallow, deepen, since,
                  not_refs):
    """Returns (pack_bytes, boundary_set, included_set) for a fetch."""
    shallow_mode = deepen is not None or since is not None or not_refs
    if shallow_mode:
        commits, boundary = _shallow_walk(wants, deepen, since, not_refs)
        incl = set()
        for c in commits:
            incl |= closure(OBJECTS, [c], depth=1)
        for want in wants:  # tags wrapping the wants ride along
            if want in OBJECTS and OBJECTS[want][0] == "tag":
                incl.add(want)
    else:
        incl = closure(OBJECTS, wants)
        boundary = set()
    excl = set()
    for h in haves:
        if h in client_shallow:
            excl |= closure(OBJECTS, [h], depth=1)
        else:
            excl |= closure(OBJECTS, [h])
    pack_oids = sorted(incl - excl)
    pack = write_pack([(OBJECTS[o][0], OBJECTS[o][1]) for o in pack_oids
                       if o in OBJECTS])
    return pack, boundary, incl


def _fetch(handler, repo, args, raw_body):
    wants, haves, client_shallow = [], [], []
    deepen = None
    since = None
    not_refs = []
    done = False
    for raw in args:
        text = raw.decode("utf-8", "replace").rstrip("\n")
        if text.startswith("want "):
            wants.append(text[5:].strip())
        elif text.startswith("have "):
            haves.append(text[5:].strip())
        elif text.startswith("shallow "):
            client_shallow.append(text[8:].strip())
        elif text.startswith("deepen "):
            try:
                deepen = int(text[7:].strip())
            except ValueError:
                pass
        elif text.startswith("deepen-since "):
            try:
                since = int(text[13:].strip())
            except ValueError:
                pass
        elif text.startswith("deepen-not "):
            ref = text[11:].strip()
            oid = repo.refs.get(ref)
            if oid:
                not_refs.append(oid)
        elif text == "done":
            done = True

    out = bytearray()
    # acknowledgments section (the suite client parses sections generically
    # and expects ACK/NAK plus "ready" last when the request carried done).
    out += pkt("acknowledgments\n")
    common = [h for h in haves if h in OBJECTS]
    if common:
        for h in common:
            out += pkt("ACK %s\n" % h)
    else:
        out += pkt("NAK\n")
    if not done:
        out += PKT_FLUSH
        handler._send(200, bytes(out), "application/x-git-upload-pack-result")
        return
    out += pkt("ready\n")
    out += PKT_DELIM

    req_key = (repo.name, tuple(sorted(wants)), deepen, since,
               tuple(sorted(haves)), tuple(sorted(client_shallow)),
               tuple(sorted(not_refs)))
    with PACK_CACHE_LOCK:
        cached = PACK_CACHE.get(req_key)
    if cached is None:
        # one thread computes a given pack; concurrent identical fetches
        # wait and then read it back from the cache
        with PACK_COMPUTE_LOCK:
            with PACK_CACHE_LOCK:
                cached = PACK_CACHE.get(req_key)
            if cached is None:
                cached = _compute_pack(repo, wants, haves, client_shallow,
                                       deepen, since, not_refs)
                with PACK_CACHE_LOCK:
                    if len(PACK_CACHE) > 128:
                        PACK_CACHE.clear()
                    PACK_CACHE[req_key] = cached
    pack, boundary, incl = cached
    shallow_mode = deepen is not None or since is not None or not_refs

    if shallow_mode or client_shallow:
        out += pkt("shallow-info\n")
        for oid in sorted(boundary):
            if oid not in client_shallow:
                out += pkt("shallow %s\n" % oid)
        for oid in client_shallow:
            obj = get_object(oid)
            if obj is not None and obj[0] == "commit":
                parents = parse_commit(obj[1])["parents"]
                if any(p in incl for p in parents):
                    out += pkt("unshallow %s\n" % oid)
        out += PKT_DELIM
    out += pkt("packfile\n")
    for i in range(0, len(pack), 65512):
        out += pkt(b"\x01" + pack[i:i + 65512])
    if not pack:
        out += pkt(b"\x01")
    out += PKT_FLUSH
    handler._send(200, bytes(out), "application/x-git-upload-pack-result")


def _upload_pack_v0(handler, repo, body):
    wants, haves = [], []
    lines, pos = parse_pkt_lines(body)
    done = False
    rest = body[pos:] if pos else b""
    for line in lines:
        if line in ("flush", "delim"):
            continue
        text = line.decode("utf-8", "replace").rstrip("\n")
        if text.startswith("want "):
            wants.append(text[5:].split(" ")[0])
        elif text.startswith("have "):
            haves.append(text[5:].strip())
    if b"done" in rest or any(
            l.decode("utf-8", "replace").strip() == "done" for l in lines
            if isinstance(l, bytes)):
        done = True
    incl = closure(OBJECTS, wants)
    excl = set()
    for h in haves:
        excl |= closure(OBJECTS, [h])
    pack_oids = sorted(incl - excl)
    pack = write_pack([(OBJECTS[o][0], OBJECTS[o][1]) for o in pack_oids
                       if o in OBJECTS])
    out = bytearray()
    common = [h for h in haves if h in OBJECTS]
    out += pkt("ACK %s\n" % common[-1]) if common else pkt("NAK\n")
    for i in range(0, len(pack), 65512):
        out += pkt(b"\x01" + pack[i:i + 65512])
    if not pack:
        out += pkt(b"\x01")
    out += PKT_FLUSH
    handler._send(200, bytes(out), "application/x-git-upload-pack-result")


def _receive_pack(handler, repo, body):
    lines, pos = parse_pkt_lines(body)
    commands = []
    for line in lines:
        if line == "flush":
            break
        if not isinstance(line, bytes):
            continue
        text = line.split(b"\0")[0].decode("utf-8", "replace").rstrip("\n")
        fields = text.split(" ")
        if len(fields) == 3:
            commands.append(fields)  # old, new, ref
    pack_data = body[pos:] if pos < len(body) else b""
    unpack_error = None
    if pack_data:
        try:
            objects = read_pack(pack_data,
                                resolve_external=lambda oid: OBJECTS.get(oid))
            with STORE_LOCK:
                for oid, (type_, data) in objects.items():
                    OBJECTS[oid] = (type_, data)
        except Exception as exc:
            unpack_error = str(exc)

    report = bytearray()
    report += pkt("unpack ok\n" if unpack_error is None
                  else "unpack %s\n" % unpack_error)
    for old, new, ref in commands:
        current = repo.refs.get(ref, ZERO_OID)
        reason = None
        if unpack_error is not None:
            reason = "unpacker error"
        elif old != current:
            reason = "stale info"
        elif new == ZERO_OID:  # delete
            if ref == repo.head_ref:
                reason = "deletion of the current branch prohibited"
        elif new not in OBJECTS:
            reason = "bad object"
        elif old != ZERO_OID and not is_ancestor(OBJECTS, old, new):
            reason = "non-fast-forward"
        if reason is not None:
            report += pkt("ng %s %s\n" % (ref, reason))
        else:
            report += pkt("ok %s\n" % ref)
            with STORE_LOCK:
                if new == ZERO_OID:
                    repo.refs.pop(ref, None)
                else:
                    repo.refs[ref] = new
    report += PKT_FLUSH
    out = bytearray()
    for i in range(0, len(report), 65512):
        out += pkt(b"\x01" + report[i:i + 65512])
    out += PKT_FLUSH
    handler._send(200, bytes(out), "application/x-git-receive-pack-result")


def git_dispatch(handler, method, parts, path, query, body):
    if len(parts) < 3:
        return None
    if parts[2:] == ["info", "refs"]:
        leaf = "info/refs"
    elif parts[2] in ("git-upload-pack", "git-receive-pack") and len(parts) == 3:
        leaf = parts[2]
    else:
        return None
    repo = _repo_from_parts(parts)
    if repo is None:
        handler.send_error_json(404, "Not Found")
        return True
    if method == "GET" and leaf == "info/refs":
        service = query.get("service", "")
        if service not in ("git-upload-pack", "git-receive-pack"):
            handler.send_error_json(400, "bad service")
            return True
        _advertise(handler, repo, service)
        return True
    if method == "POST" and leaf == "git-upload-pack":
        command, _caps, args = _parse_command(body)
        if command == "ls-refs":
            _ls_refs(handler, repo, args)
        elif command == "fetch":
            _fetch(handler, repo, args, body)
        elif command is None:
            _upload_pack_v0(handler, repo, body)
        else:
            handler.send_error_json(400, "unknown command")
        return True
    if method == "POST" and leaf == "git-receive-pack":
        _receive_pack(handler, repo, body)
        return True
    return None


# --------------------------------------------------------------------------
# REST v3 (mounted under /api/v3)
# --------------------------------------------------------------------------

import base64
import difflib

COMMENT_SEQ = [0]
ISSUE_ID_SEQ = [0]


def _iso(ts):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts))


def repo_json(repo):
    login = OWNER["login"] or repo.owner_login or "viewer"
    return {
        "id": repo.id,
        "node_id": node_id("Repository", repo.name),
        "name": repo.name,
        "full_name": "%s/%s" % (login, repo.name),
        "private": repo.private,
        "owner": {"login": login, "id": 1, "type": "User"},
        "description": repo.description,
        "fork": False,
        "default_branch": repo.default_branch,
        "created_at": _iso(1700000000 + repo.id),
        "updated_at": _iso(1700000000 + repo.id),
        "html_url": "http://forge.local/%s/%s" % (login, repo.name),
        "clone_url": "http://forge.local/%s/%s.git" % (login, repo.name),
    }


def _tree_files_of_commit(commit_oid):
    if not commit_oid:
        return {}
    obj = get_object(commit_oid)
    if obj is None or obj[0] != "commit":
        return {}
    tree = parse_commit(obj[1])["tree"]
    return read_tree_files(tree)


def _commit_on_branch(repo, branch, files, message):
    """Commit a full file map onto a branch; returns the new commit oid."""
    tree_oid = build_tree_from_files(files)
    tip = repo.branch_oid(branch)
    parents = [tip] if tip else []
    commit = make_commit(tree_oid, parents, message)
    with STORE_LOCK:
        repo.refs["refs/heads/" + branch] = commit
    return commit


def _apply_content_change(repo, branch, path, blob_oid_or_none, message):
    tip = repo.branch_oid(branch)
    files = _tree_files_of_commit(tip)
    if blob_oid_or_none is None:
        files.pop(path, None)
    else:
        files[path] = ("100644", blob_oid_or_none)
    return _commit_on_branch(repo, branch, files, message)


def _paginate(handler, items, query):
    try:
        per_page = int(query.get("per_page", "30"))
    except ValueError:
        per_page = 30
    per_page = max(1, min(per_page, 100))
    try:
        page = int(query.get("page", "1"))
    except ValueError:
        page = 1
    page = max(1, page)
    start = (page - 1) * per_page
    chunk = items[start:start + per_page]
    headers = []
    if start + per_page < len(items):
        host = handler.headers.get("Host", "127.0.0.1")
        from urllib.parse import urlparse
        path = urlparse(handler.path).path
        url = "http://%s%s?per_page=%d&page=%d" % (host, path, per_page,
                                                   page + 1)
        headers.append(("Link", '<%s>; rel="next"' % url))
    return chunk, headers


def _json_body(handler, body):
    """Returns (obj, ok). On malformed JSON sends a 400 and returns ok=False."""
    if not body:
        return {}, True
    try:
        obj = json.loads(body.decode("utf-8"))
    except Exception:
        handler.send_error_json(400, "Malformed JSON in request body")
        return None, False
    if not isinstance(obj, dict):
        handler.send_error_json(400, "Request body must be a JSON object")
        return None, False
    return obj, True


def issue_json(repo, issue):
    return {
        "id": issue["id"],
        "node_id": issue.get("node_id") or node_id("Issue", repo.name,
                                                   issue["number"]),
        "number": issue["number"],
        "title": issue["title"],
        "body": issue["body"],
        "state": issue["state"],
        "labels": [{"name": name,
                    "color": repo.labels.get(name, {}).get("color", "ededed")}
                   for name in issue["labels"]],
        "comments": len(issue["comments"]),
        "user": {"login": OWNER["login"] or "viewer", "id": 1},
        "created_at": issue["created_at"],
        "updated_at": issue["updated_at"],
        "html_url": "http://forge.local/issues/%d" % issue["number"],
    }


def pull_json(repo, pull):
    head_tip = repo.branch_oid(pull["head"]) or ZERO_OID
    base_tip = repo.branch_oid(pull["base"]) or ZERO_OID
    return {
        "id": pull["id"],
        "node_id": pull.get("node_id") or node_id("PullRequest", repo.name,
                                                  pull["number"]),
        "number": pull["number"],
        "state": pull["state"],
        "title": pull["title"],
        "body": pull["body"],
        "head": {"ref": pull["head"], "sha": head_tip,
                 "label": pull["head"]},
        "base": {"ref": pull["base"], "sha": base_tip,
                 "label": pull["base"]},
        "merged": pull["merged"],
        "merged_at": pull["merged_at"],
        "merge_commit_sha": pull["merge_commit_sha"],
        "user": {"login": OWNER["login"] or "viewer", "id": 1},
        "created_at": pull["created_at"],
        "updated_at": pull["updated_at"],
        "html_url": "http://forge.local/pull/%d" % pull["number"],
    }


def _merge_base(a, b):
    if not a or not b:
        return None
    ancestors = set()
    stack = [a]
    while stack:
        oid = stack.pop()
        if oid in ancestors:
            continue
        obj = get_object(oid)
        if obj is None or obj[0] != "commit":
            continue
        ancestors.add(oid)
        stack.extend(parse_commit(obj[1])["parents"])
    seen = set()
    queue = [b]
    while queue:
        oid = queue.pop(0)
        if oid in ancestors:
            return oid
        if oid in seen:
            continue
        seen.add(oid)
        obj = get_object(oid)
        if obj is None or obj[0] != "commit":
            continue
        queue.extend(parse_commit(obj[1])["parents"])
    return None


def _diff_counts(base_data, head_data):
    base_lines = base_data.decode("utf-8", "replace").splitlines()
    head_lines = head_data.decode("utf-8", "replace").splitlines()
    matcher = difflib.SequenceMatcher(None, base_lines, head_lines,
                                      autojunk=False)
    additions = deletions = 0
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag in ("insert", "replace"):
            additions += j2 - j1
        if tag in ("delete", "replace"):
            deletions += i2 - i1
    return additions, deletions


def _changed_files(repo, base_tip, head_tip):
    base_files = _tree_files_of_commit(base_tip)
    head_files = _tree_files_of_commit(head_tip)
    out = []
    for path in sorted(set(base_files) | set(head_files)):
        in_base = path in base_files
        in_head = path in head_files
        if in_base and in_head and base_files[path][1] == head_files[path][1]:
            continue
        base_data = get_object(base_files[path][1])[1] if in_base else b""
        head_data = get_object(head_files[path][1])[1] if in_head else b""
        additions, deletions = _diff_counts(base_data, head_data)
        status = "modified" if in_base and in_head else \
            ("added" if in_head else "removed")
        out.append({"filename": path, "status": status,
                    "additions": additions, "deletions": deletions,
                    "changes": additions + deletions,
                    "sha": head_files[path][1] if in_head else
                    base_files[path][1]})
    return out


def _three_way_merge(base_files, head_files, branch_files):
    """Returns (merged_files, conflict_bool)."""
    merged = {}
    paths = set(base_files) | set(head_files) | set(branch_files)
    for path in paths:
        anc = base_files.get(path)
        head = head_files.get(path)
        branch = branch_files.get(path)
        if head == branch:
            if head is not None:
                merged[path] = head
        elif anc == branch:
            if head is not None:
                merged[path] = head
        elif anc == head:
            if branch is not None:
                merged[path] = branch
        else:
            return None, True
    return merged, False


def rest_dispatch(handler, method, parts, path, query, body):
    if len(parts) < 2 or parts[0] != "api" or parts[1] != "v3":
        return None
    rest = parts[2:]

    if not rest:  # GET /api/v3/
        if method == "GET":
            handler.send_json(200, {
                "current_user_url": "http://forge.local/api/v3/user",
                "repository_url": "http://forge.local/api/v3/repos/{owner}/{repo}",
            }, extra_headers=[("X-OAuth-Scopes", "repo")])
            return True
        return None
    if rest == ["meta"] and method == "GET":
        handler.send_json(200, {"installed_version": "1.0.0"})
        return True
    if rest == ["user"] and method == "GET":
        handler.send_json(200, {"login": OWNER["login"] or "viewer",
                                "id": 1, "type": "User"})
        return True
    if rest == ["user", "repos"]:
        if method == "POST":
            data, ok = _json_body(handler, body)
            if not ok:
                return True
            name = data.get("name")
            if not name:
                handler.send_error_json(422, "name is required")
                return True
            if name in REPOS:
                handler.send_error_json(422, "name already exists on this "
                                             "account")
                return True
            repo = create_repo(name)
            repo.description = data.get("description") or ""
            repo.private = bool(data.get("private", False))
            if OWNER["login"]:
                repo.owner_login = OWNER["login"]
            handler.send_json(201, repo_json(repo))
            return True
        if method == "GET":
            repos = sorted(REPOS.values(), key=lambda r: r.id)
            chunk, headers = _paginate(handler,
                                       [repo_json(r) for r in repos], query)
            handler.send_json(200, chunk, extra_headers=headers)
            return True
        return None
    if len(rest) >= 3 and rest[0] == "repos":
        owner, name = rest[1], rest[2]
        repo = find_repo(owner, name)
        sub = rest[3:]
        if repo is None:
            handler.send_error_json(404, "Not Found")
            return True
        return _repo_dispatch(handler, method, repo, sub, query, body)
    return None


def _repo_dispatch(handler, method, repo, sub, query, body):
    if not sub:
        if method == "GET":
            handler.send_json(200, repo_json(repo))
            return True
        if method == "PATCH":
            data, ok = _json_body(handler, body)
            if not ok:
                return True
            if "description" in data:
                repo.description = data["description"] or ""
            if "private" in data:
                repo.private = bool(data["private"])
            if "name" in data and data["name"] != repo.name:
                new = data["name"]
                REPOS.pop(repo.name, None)
                repo.name = new
                REPOS[new] = repo
            if "default_branch" in data:
                repo.default_branch = data["default_branch"]
            handler.send_json(200, repo_json(repo))
            return True
        if method == "DELETE":
            REPOS.pop(repo.name, None)
            handler._send(204, b"", "application/json; charset=utf-8")
            return True
        return None

    if sub == ["git", "refs"] and method == "POST":
        data, ok = _json_body(handler, body)
        if not ok:
            return True
        ref = data.get("ref", "")
        sha = data.get("sha", "")
        if not ref.startswith("refs/") or sha not in OBJECTS:
            handler.send_error_json(422, "Invalid ref or sha")
            return True
        if ref in repo.refs:
            handler.send_error_json(422, "Reference already exists")
            return True
        with STORE_LOCK:
            repo.refs[ref] = sha
        handler.send_json(201, {"ref": ref, "node_id": node_id("Ref",
                                                               repo.name),
                                "object": {"sha": sha, "type": "commit"}})
        return True
    if len(sub) >= 3 and sub[:2] == ["git", "refs"] and method == "GET":
        ref = "/".join(sub[2:])
        if not ref.startswith("refs/"):
            ref = "refs/" + ref
        oid = repo.refs.get(ref)
        if oid is None:
            handler.send_error_json(404, "Not Found")
            return True
        handler.send_json(200, {"ref": ref,
                                "object": {"sha": oid, "type": "commit"}})
        return True

    if sub == ["branches"] and method == "GET":
        branches = []
        for ref, oid in _sorted_refs(repo):
            if ref.startswith("refs/heads/"):
                branches.append({"name": ref[len("refs/heads/"):],
                                 "commit": {"sha": oid}, "protected": False})
        handler.send_json(200, branches)
        return True
    if len(sub) == 2 and sub[0] == "branches" and method == "GET":
        oid = repo.branch_oid(sub[1])
        if oid is None:
            handler.send_error_json(404, "Not Found")
            return True
        handler.send_json(200, {"name": sub[1], "commit": {"sha": oid},
                                "protected": False})
        return True

    if sub == ["commits"] and method == "GET":
        sha_ref = query.get("sha") or repo.default_branch
        tip = repo.refs.get(sha_ref) or repo.branch_oid(sha_ref) or \
            (sha_ref if sha_ref in OBJECTS else None)
        commits = []
        seen = set()
        stack = [tip] if tip else []
        while stack and len(commits) < 500:
            oid = stack.pop(0)
            if oid in seen:
                continue
            seen.add(oid)
            obj = get_object(oid)
            if obj is None or obj[0] != "commit":
                continue
            parsed = parse_commit(obj[1])
            commits.append({
                "sha": oid,
                "commit": {"message": parsed["message"],
                           "author": {"name": AUTHOR_LINE.split(" <")[0],
                                      "email": "forge@example.com",
                                      "date": _iso(1700000000)},
                           "committer": {"name": AUTHOR_LINE.split(" <")[0],
                                         "email": "forge@example.com",
                                         "date": _iso(1700000000)},
                           "tree": {"sha": parsed["tree"]}},
                "parents": [{"sha": p} for p in parsed["parents"]],
            })
            stack = parsed["parents"][:1] + stack
        chunk, headers = _paginate(handler, commits, query)
        handler.send_json(200, chunk, extra_headers=headers)
        return True

    if sub and sub[0] == "contents":
        return _contents_dispatch(handler, method, repo, sub[1:], query, body)

    if sub == ["labels"]:
        if method == "POST":
            data, ok = _json_body(handler, body)
            if not ok:
                return True
            lname = data.get("name")
            if not lname:
                handler.send_error_json(422, "name is required")
                return True
            if lname in repo.labels:
                handler.send_error_json(422, "Label already exists")
                return True
            color = data.get("color") or "ededed"
            repo.labels[lname] = {"name": lname, "color": color}
            handler.send_json(201, {"id": len(repo.labels), "name": lname,
                                    "color": color, "default": False})
            return True
        if method == "GET":
            handler.send_json(200, [dict(v) for v in repo.labels.values()])
            return True
        return None

    if sub and sub[0] == "issues":
        return _issues_dispatch(handler, method, repo, sub[1:], query, body)
    if sub and sub[0] == "pulls":
        return _pulls_dispatch(handler, method, repo, sub[1:], query, body)
    return None


def _contents_dispatch(handler, method, repo, path_parts, query, body):
    from urllib.parse import unquote
    cpath = unquote("/".join(path_parts))
    if method == "GET":
        ref = query.get("ref") or repo.default_branch
        tip = repo.branch_oid(ref) or repo.refs.get(ref) or \
            (ref if ref in OBJECTS else None)
        files = _tree_files_of_commit(tip)
        if cpath and cpath in files:
            mode, oid = files[cpath]
            data = get_object(oid)[1]
            handler.send_json(200, {
                "name": cpath.rsplit("/", 1)[-1], "path": cpath,
                "sha": oid, "size": len(data), "type": "file",
                "encoding": "base64",
                "content": base64.b64encode(data).decode(),
            })
            return True
        prefix = (cpath + "/") if cpath else ""
        entries = {}
        for fpath, (mode, oid) in files.items():
            if not fpath.startswith(prefix):
                continue
            rest = fpath[len(prefix):]
            head, sep, _ = rest.partition("/")
            if sep:
                if head not in entries:
                    entries[head] = {"name": head, "path": prefix + head,
                                     "sha": ZERO_OID, "size": 0,
                                     "type": "dir"}
            else:
                entries[head] = {"name": head, "path": fpath, "sha": oid,
                                 "size": len(get_object(oid)[1]),
                                 "type": "file"}
        if entries or not cpath:
            handler.send_json(200, [entries[k] for k in sorted(entries)])
            return True
        handler.send_error_json(404, "Not Found")
        return True
    if method == "PUT":
        data, ok = _json_body(handler, body)
        if not ok:
            return True
        branch = data.get("branch") or repo.default_branch
        tip = repo.branch_oid(branch)
        files = _tree_files_of_commit(tip)
        existing = files.get(cpath)
        raw = base64.b64decode(
            "".join((data.get("content") or "").split()))
        blob_oid = store_object("blob", raw)
        if existing is not None:
            if data.get("sha") != existing[1]:
                handler.send_error_json(
                    409, "the sha supplied does not match the file's sha")
                return True
            status = 200
        else:
            status = 201
        commit = _apply_content_change(repo, branch, cpath, blob_oid,
                                       data.get("message") or "update")
        handler.send_json(status, {
            "content": {"name": cpath.rsplit("/", 1)[-1], "path": cpath,
                        "sha": blob_oid, "size": len(raw), "type": "file",
                        "encoding": "base64"},
            "commit": {"sha": commit,
                       "message": data.get("message") or "update"},
        })
        return True
    if method == "DELETE":
        data, ok = _json_body(handler, body)
        if not ok:
            return True
        branch = data.get("branch") or repo.default_branch
        tip = repo.branch_oid(branch)
        files = _tree_files_of_commit(tip)
        existing = files.get(cpath)
        if existing is None:
            handler.send_error_json(404, "Not Found")
            return True
        if data.get("sha") != existing[1]:
            handler.send_error_json(
                409, "the sha supplied does not match the file's sha")
            return True
        commit = _apply_content_change(repo, branch, cpath, None,
                                       data.get("message") or "delete")
        handler.send_json(200, {"content": None,
                                "commit": {"sha": commit,
                                           "message": data.get("message")
                                           or "delete"}})
        return True
    return None


def _issues_dispatch(handler, method, repo, sub, query, body):
    if not sub:
        if method == "POST":
            data, ok = _json_body(handler, body)
            if not ok:
                return True
            labels = []
            for item in data.get("labels") or []:
                lname = item.get("name") if isinstance(item, dict) else item
                if lname not in repo.labels:
                    handler.send_error_json(
                        422, "Label '%s' does not exist" % lname)
                    return True
                labels.append(lname)
            ISSUE_ID_SEQ[0] += 1
            number = repo.next_number
            repo.next_number += 1
            now = _iso(int(time.time()))
            issue = {"id": ISSUE_ID_SEQ[0], "number": number,
                     "title": data.get("title") or "",
                     "body": data.get("body") or "",
                     "state": "open", "labels": labels, "comments": [],
                     "created_at": now, "updated_at": now,
                     "node_id": node_id("Issue", repo.name, number)}
            repo.issues[number] = issue
            handler.send_json(201, issue_json(repo, issue))
            return True
        if method == "GET":
            state = query.get("state", "open")
            items = [i for i in repo.issues.values()
                     if state == "all" or i["state"] == state]
            direction = query.get("direction", "desc")
            items.sort(key=lambda i: i["number"],
                       reverse=(direction != "asc"))
            chunk, headers = _paginate(
                handler, [issue_json(repo, i) for i in items], query)
            handler.send_json(200, chunk, extra_headers=headers)
            return True
        return None
    if len(sub) >= 1 and sub[0].isdigit():
        number = int(sub[0])
        issue = repo.issues.get(number)
        if issue is None:
            handler.send_error_json(404, "Not Found")
            return True
        if len(sub) == 1:
            if method == "GET":
                handler.send_json(200, issue_json(repo, issue))
                return True
            if method == "PATCH":
                data, ok = _json_body(handler, body)
                if not ok:
                    return True
                if "state" in data:
                    issue["state"] = data["state"]
                if "title" in data:
                    issue["title"] = data["title"]
                if "body" in data:
                    issue["body"] = data["body"]
                if "labels" in data:
                    labels = []
                    for item in data["labels"] or []:
                        lname = item.get("name") if isinstance(item, dict) \
                            else item
                        if lname not in repo.labels:
                            handler.send_error_json(
                                422, "Label '%s' does not exist" % lname)
                            return True
                        labels.append(lname)
                    issue["labels"] = labels
                issue["updated_at"] = _iso(int(time.time()))
                handler.send_json(200, issue_json(repo, issue))
                return True
            return None
        if len(sub) == 2 and sub[1] == "comments":
            if method == "POST":
                data, ok = _json_body(handler, body)
                if not ok:
                    return True
                COMMENT_SEQ[0] += 1
                comment = {"id": COMMENT_SEQ[0],
                           "body": data.get("body") or "",
                           "user": {"login": OWNER["login"] or "viewer",
                                    "id": 1},
                           "created_at": _iso(int(time.time())),
                           "updated_at": _iso(int(time.time()))}
                issue["comments"].append(comment)
                handler.send_json(201, comment)
                return True
            if method == "GET":
                handler.send_json(200, issue["comments"])
                return True
            return None
    return None


def _do_merge(repo, pull, method="squash", commit_title=None):
    """Merge a pull request. Returns (commit_oid, None) or (None, reason).
    method: 'squash' (one parent) or 'merge' (two parents)."""
    if pull["merged"]:
        return None, "already merged"
    if pull["state"] != "open":
        return None, "not open"
    head_tip = repo.branch_oid(pull["head"])
    base_tip = repo.branch_oid(pull["base"])
    if head_tip is None or base_tip is None:
        return None, "missing branch"
    mb = _merge_base(base_tip, head_tip)
    anc_files = _tree_files_of_commit(mb) if mb else {}
    head_files = _tree_files_of_commit(head_tip)
    base_files = _tree_files_of_commit(base_tip)
    merged_files, conflict = _three_way_merge(anc_files, head_files,
                                              base_files)
    if conflict:
        return None, "conflict"
    tree_oid = build_tree_from_files(merged_files)
    title = commit_title or pull["title"]
    if method == "merge":
        parents = [base_tip, head_tip]
    else:
        parents = [base_tip]
    commit = make_commit(tree_oid, parents, title)
    with STORE_LOCK:
        repo.refs["refs/heads/" + pull["base"]] = commit
    pull["state"] = "closed"
    pull["merged"] = True
    pull["merged_at"] = _iso(int(time.time()))
    pull["merge_commit_sha"] = commit
    pull["updated_at"] = _iso(int(time.time()))
    return commit, None


def _pulls_dispatch(handler, method, repo, sub, query, body):
    if not sub:
        if method == "POST":
            data, ok = _json_body(handler, body)
            if not ok:
                return True
            head = (data.get("head") or "").split(":")[-1]
            base = (data.get("base") or repo.default_branch).split(":")[-1]
            if repo.branch_oid(head) is None:
                handler.send_error_json(422, "head branch does not exist")
                return True
            if repo.branch_oid(base) is None:
                handler.send_error_json(422, "base branch does not exist")
                return True
            ISSUE_ID_SEQ[0] += 1
            number = repo.next_number
            repo.next_number += 1
            now = _iso(int(time.time()))
            pull = {"id": ISSUE_ID_SEQ[0], "number": number,
                    "title": data.get("title") or "",
                    "body": data.get("body") or "",
                    "state": "open", "head": head, "base": base,
                    "merged": False, "merged_at": None,
                    "merge_commit_sha": None,
                    "created_at": now, "updated_at": now,
                    "node_id": node_id("PullRequest", repo.name, number)}
            repo.pulls[number] = pull
            handler.send_json(201, pull_json(repo, pull))
            return True
        if method == "GET":
            state = query.get("state", "open")
            items = [p for p in repo.pulls.values()
                     if state == "all" or p["state"] == state]
            items.sort(key=lambda p: p["number"])
            chunk, headers = _paginate(
                handler, [pull_json(repo, p) for p in items], query)
            handler.send_json(200, chunk, extra_headers=headers)
            return True
        return None
    if len(sub) >= 1 and sub[0].isdigit():
        number = int(sub[0])
        pull = repo.pulls.get(number)
        if len(sub) == 1 and method == "GET":
            if pull is None:
                handler.send_error_json(404, "Not Found")
                return True
            handler.send_json(200, pull_json(repo, pull))
            return True
        if pull is None:
            handler.send_error_json(404, "Not Found")
            return True
        if len(sub) == 2 and sub[1] == "files" and method == "GET":
            head_tip = repo.branch_oid(pull["head"])
            base_tip = repo.branch_oid(pull["base"])
            mb = _merge_base(base_tip, head_tip)
            files = _changed_files(repo, mb or base_tip, head_tip)
            chunk, headers = _paginate(handler, files, query)
            handler.send_json(200, chunk, extra_headers=headers)
            return True
        if len(sub) == 2 and sub[1] == "merge" and method == "PUT":
            data, ok = _json_body(handler, body)
            if not ok:
                return True
            merge_method = (data.get("merge_method") or "squash").lower()
            commit, err = _do_merge(
                repo, pull,
                method="merge" if merge_method == "merge" else "squash",
                commit_title=data.get("commit_title") or pull["title"])
            if err == "conflict":
                handler.send_error_json(
                    405, "Pull Request is not mergeable: conflicts")
                return True
            if err is not None:
                handler.send_error_json(405, "Pull Request %s" % err)
                return True
            handler.send_json(200, {
                "sha": commit, "merged": True,
                "message": "Pull Request successfully merged"})
            return True
    return None


# --------------------------------------------------------------------------
# GraphQL v4 (POST /api/graphql)
# --------------------------------------------------------------------------

class GQLParseError(Exception):
    pass


_GQL_PUNCT = set("{}()[]:=@$!|&")


def _gql_tokens(text):
    tokens = []
    i, n = 0, len(text)
    while i < n:
        ch = text[i]
        if ch in " \t\r\n,":
            i += 1
            continue
        if ch == "#":
            while i < n and text[i] != "\n":
                i += 1
            continue
        if text.startswith("...", i):
            tokens.append(("spread", "..."))
            i += 3
            continue
        if ch in _GQL_PUNCT:
            tokens.append(("punct", ch))
            i += 1
            continue
        if ch == '"':
            if text.startswith('"""', i):
                end = text.find('"""', i + 3)
                if end < 0:
                    raise GQLParseError("unterminated block string")
                tokens.append(("string", text[i + 3:end]))
                i = end + 3
                continue
            j = i + 1
            buf = []
            while j < n and text[j] != '"':
                if text[j] == "\\" and j + 1 < n:
                    esc = text[j + 1]
                    buf.append({"n": "\n", "t": "\t", "r": "\r", "b": "\b",
                                "f": "\f", "/": "/", "\\": "\\",
                                '"': '"'}.get(esc, esc))
                    j += 2
                else:
                    buf.append(text[j])
                    j += 1
            if j >= n:
                raise GQLParseError("unterminated string")
            tokens.append(("string", "".join(buf)))
            i = j + 1
            continue
        if ch.isalpha() or ch == "_":
            j = i
            while j < n and (text[j].isalnum() or text[j] == "_"):
                j += 1
            tokens.append(("name", text[i:j]))
            i = j
            continue
        if ch.isdigit() or ch == "-":
            j = i
            while j < n and (text[j].isdigit() or text[j] in ".eE+-"):
                j += 1
            tokens.append(("number", text[i:j]))
            i = j
            continue
        raise GQLParseError("unexpected character %r" % ch)
    tokens.append(("eof", ""))
    return tokens


class _GQLParser:
    def __init__(self, tokens):
        self.tokens = tokens
        self.pos = 0

    def peek(self):
        return self.tokens[self.pos]

    def next(self):
        tok = self.tokens[self.pos]
        self.pos += 1
        return tok

    def expect_punct(self, ch):
        tok = self.next()
        if tok != ("punct", ch):
            raise GQLParseError("expected %r, got %r" % (ch, tok))

    def expect_name(self):
        tok = self.next()
        if tok[0] != "name":
            raise GQLParseError("expected a name, got %r" % (tok,))
        return tok[1]

    def parse_document(self):
        operations = []
        fragments = {}
        while self.peek()[0] != "eof":
            tok = self.peek()
            if tok == ("punct", "{"):
                operations.append({
                    "type": "query", "name": None, "var_defs": {},
                    "selection": self.parse_selection_set()})
            elif tok[0] == "name" and tok[1] in ("query", "mutation",
                                                 "subscription"):
                self.next()
                op = {"type": tok[1], "name": None, "var_defs": {}}
                if self.peek()[0] == "name":
                    op["name"] = self.next()[1]
                if self.peek() == ("punct", "("):
                    op["var_defs"] = self.parse_var_defs()
                self._skip_directives()
                op["selection"] = self.parse_selection_set()
                operations.append(op)
            elif tok[0] == "name" and tok[1] == "fragment":
                self.next()
                fname = self.expect_name()
                if self.expect_name() != "on":
                    raise GQLParseError("fragment without 'on'")
                type_cond = self.expect_name()
                self._skip_directives()
                fragments[fname] = {"type": type_cond,
                                    "selection": self.parse_selection_set()}
            else:
                raise GQLParseError("unexpected token %r" % (tok,))
        return operations, fragments

    def _skip_directives(self):
        while self.peek() == ("punct", "@"):
            self.next()
            self.expect_name()
            if self.peek() == ("punct", "("):
                self.parse_arguments()

    def parse_var_defs(self):
        defs = {}
        self.expect_punct("(")
        while self.peek() != ("punct", ")"):
            self.expect_punct("$")
            name = self.expect_name()
            self.expect_punct(":")
            self.parse_type()
            default = None
            if self.peek() == ("punct", "="):
                self.next()
                default = self.parse_value()
            self._skip_directives()
            defs[name] = default
        self.next()
        return defs

    def parse_type(self):
        if self.peek() == ("punct", "["):
            self.next()
            self.parse_type()
            self.expect_punct("]")
        else:
            self.expect_name()
        if self.peek() == ("punct", "!"):
            self.next()

    def parse_selection_set(self):
        self.expect_punct("{")
        fields = []
        while self.peek() != ("punct", "}"):
            fields.append(self.parse_selection())
        self.next()
        return fields

    def parse_selection(self):
        if self.peek()[0] == "spread":
            self.next()
            if self.peek()[0] == "name" and self.peek()[1] == "on":
                self.next()
                type_cond = self.expect_name()
                self._skip_directives()
                return {"kind": "inline", "type": type_cond,
                        "selection": self.parse_selection_set()}
            name = self.expect_name()
            self._skip_directives()
            return {"kind": "spread", "name": name}
        first = self.expect_name()
        alias = None
        name = first
        if self.peek() == ("punct", ":"):
            self.next()
            alias = first
            name = self.expect_name()
        args = {}
        if self.peek() == ("punct", "("):
            args = self.parse_arguments()
        self._skip_directives()
        selection = None
        if self.peek() == ("punct", "{"):
            selection = self.parse_selection_set()
        return {"kind": "field", "alias": alias, "name": name, "args": args,
                "selection": selection}

    def parse_arguments(self):
        args = {}
        self.expect_punct("(")
        while self.peek() != ("punct", ")"):
            name = self.expect_name()
            self.expect_punct(":")
            args[name] = self.parse_value()
        self.next()
        return args

    def parse_value(self):
        tok = self.next()
        if tok == ("punct", "$"):
            return ("var", self.expect_name())
        if tok == ("punct", "["):
            items = []
            while self.peek() != ("punct", "]"):
                items.append(self.parse_value())
            self.next()
            return ("list", items)
        if tok == ("punct", "{"):
            obj = {}
            while self.peek() != ("punct", "}"):
                key = self.expect_name()
                self.expect_punct(":")
                obj[key] = self.parse_value()
            self.next()
            return ("object", obj)
        if tok[0] == "string":
            return ("string", tok[1])
        if tok[0] == "number":
            try:
                return ("int", int(tok[1]))
            except ValueError:
                return ("float", float(tok[1]))
        if tok[0] == "name":
            if tok[1] == "true":
                return ("bool", True)
            if tok[1] == "false":
                return ("bool", False)
            if tok[1] == "null":
                return ("null", None)
            return ("enum", tok[1])
        raise GQLParseError("bad value token %r" % (tok,))


def _gql_value(node, variables):
    kind, val = node
    if kind == "var":
        return variables.get(val)
    if kind == "list":
        return [_gql_value(v, variables) for v in val]
    if kind == "object":
        return {k: _gql_value(v, variables) for k, v in val.items()}
    return val


# --- schema for introspection ----------------------------------------------

GQL_SCHEMA = {
    "Query": {"kind": "OBJECT", "fields": [
        "viewer", "repository", "node", "nodes", "search", "rateLimit",
        "__type", "__schema"]},
    "Mutation": {"kind": "OBJECT", "fields": [
        "createIssue", "closeIssue", "reopenIssue", "createPullRequest",
        "mergePullRequest", "addComment", "updateIssue"]},
    "User": {"kind": "OBJECT", "fields": ["login", "id", "name", "url"]},
    "Repository": {"kind": "OBJECT", "fields": [
        "id", "databaseId", "name", "nameWithOwner", "owner", "description",
        "isPrivate", "isFork", "defaultBranchRef", "viewerPermission",
        "hasIssuesEnabled", "issue", "issues", "pullRequest", "pullRequests",
        "createdAt", "updatedAt", "url", "labels", "refs", "object",
        "stargazerCount", "forkCount"]},
    "Issue": {"kind": "OBJECT", "fields": [
        "id", "databaseId", "number", "title", "state", "body", "author",
        "createdAt", "updatedAt", "closed", "closedAt", "labels", "comments",
        "repository", "url", "viewerDidAuthor"]},
    "PullRequest": {"kind": "OBJECT", "fields": [
        "id", "databaseId", "number", "title", "state", "body", "author",
        "merged", "mergedAt", "mergeable", "headRefName", "baseRefName",
        "headRefOid", "baseRefOid", "files", "commits", "comments",
        "mergeCommit", "repository", "createdAt", "updatedAt", "closed",
        "additions", "deletions", "changedFiles", "url"]},
    "IssueConnection": {"kind": "OBJECT", "fields": [
        "nodes", "edges", "pageInfo", "totalCount"]},
    "PullRequestConnection": {"kind": "OBJECT", "fields": [
        "nodes", "edges", "pageInfo", "totalCount"]},
    "PullRequestChangedFileConnection": {"kind": "OBJECT", "fields": [
        "nodes", "pageInfo", "totalCount"]},
    "PullRequestChangedFile": {"kind": "OBJECT", "fields": [
        "path", "additions", "deletions", "changeType"]},
    "PageInfo": {"kind": "OBJECT", "fields": [
        "hasNextPage", "hasPreviousPage", "startCursor", "endCursor"]},
    "Ref": {"kind": "OBJECT", "fields": ["name", "prefix", "target"]},
    "Commit": {"kind": "OBJECT", "fields": ["oid", "message", "messageHeadline"]},
    "IssueComment": {"kind": "OBJECT", "fields": [
        "id", "databaseId", "body", "author", "createdAt", "updatedAt", "url"]},
    "CreateIssuePayload": {"kind": "OBJECT", "fields": ["issue", "clientMutationId"]},
    "CloseIssuePayload": {"kind": "OBJECT", "fields": ["issue", "clientMutationId"]},
    "CreatePullRequestPayload": {"kind": "OBJECT", "fields": ["pullRequest", "clientMutationId"]},
    "MergePullRequestPayload": {"kind": "OBJECT", "fields": ["pullRequest", "clientMutationId"]},
    "AddCommentPayload": {"kind": "OBJECT", "fields": ["commentEdge", "subject", "clientMutationId"]},
    "IssueCommentEdge": {"kind": "OBJECT", "fields": ["node", "cursor"]},
    "IssueState": {"kind": "ENUM", "values": ["OPEN", "CLOSED"]},
    "PullRequestState": {"kind": "ENUM", "values": ["OPEN", "CLOSED", "MERGED"]},
    "MergeableState": {"kind": "ENUM", "values": ["MERGEABLE", "CONFLICTING", "UNKNOWN"]},
    "PullRequestMergeMethod": {"kind": "ENUM", "values": ["MERGE", "SQUASH", "REBASE"]},
    "RepositoryPermission": {"kind": "ENUM", "values": ["ADMIN", "MAINTAIN", "WRITE", "TRIAGE", "READ"]},
    "SearchType": {"kind": "ENUM", "values": ["ISSUE", "REPOSITORY", "USER", "DISCUSSION"]},
    "IssueOrderField": {"kind": "ENUM", "values": ["CREATED_AT", "UPDATED_AT", "COMMENTS"]},
    "OrderDirection": {"kind": "ENUM", "values": ["ASC", "DESC"]},
    "String": {"kind": "SCALAR"}, "Int": {"kind": "SCALAR"},
    "Boolean": {"kind": "SCALAR"}, "ID": {"kind": "SCALAR"},
}


def _gql_type_obj(name):
    info = GQL_SCHEMA.get(name)
    if info is None:
        return None
    return ("__Type", {"name": name, "kind": info["kind"],
                       "fields": info.get("fields"),
                       "values": info.get("values")})


def _cursor_for(offset):
    return base64.b64encode(("cursor:%d" % offset).encode()).decode()


def _offset_of(cursor):
    if not cursor:
        return 0
    try:
        raw = base64.b64decode(cursor.encode()).decode()
        return int(raw.split(":", 1)[1])
    except Exception:
        return 0


def _connection(items, args, node_type):
    first = args.get("first")
    after = args.get("after")
    start = _offset_of(after) + 1 if after else 0
    window = items[start:]
    if first is not None:
        window = window[:int(first)]
    end = start + len(window)
    page_info = ("PageInfo", {
        "hasNextPage": end < len(items),
        "hasPreviousPage": start > 0,
        "startCursor": _cursor_for(start) if window else None,
        "endCursor": _cursor_for(end - 1) if window else None,
    })
    return (node_type, {"nodes": window, "pageInfo": page_info,
                        "totalCount": len(items)})


class GQLContext:
    def __init__(self, variables, fragments):
        self.variables = variables
        self.fragments = fragments
        self.errors = []


def _expand_selection(selection, type_name, ctx, out):
    for sel in selection or []:
        if sel["kind"] == "field":
            out.append(sel)
        elif sel["kind"] == "inline":
            if sel["type"] == type_name:
                _expand_selection(sel["selection"], type_name, ctx, out)
        elif sel["kind"] == "spread":
            frag = ctx.fragments.get(sel["name"])
            if frag and frag["type"] == type_name:
                _expand_selection(frag["selection"], type_name, ctx, out)


def _gql_exec(obj, selection, ctx):
    """obj is a (type_name, payload) pair; returns the JSON-ready value."""
    if obj is None:
        return None
    type_name, payload = obj
    fields = []
    _expand_selection(selection, type_name, ctx, fields)
    result = {}
    for field in fields:
        key = field["alias"] or field["name"]
        args = {k: _gql_value(v, ctx.variables)
                for k, v in field["args"].items()}
        value, is_obj = _gql_field(type_name, payload, field["name"], args,
                                   ctx)
        if is_obj == "error":
            result[key] = None
            continue
        if is_obj:
            if isinstance(value, list):
                result[key] = [_gql_exec(v, field["selection"], ctx)
                               if v is not None else None for v in value]
            else:
                result[key] = _gql_exec(value, field["selection"], ctx)
        else:
            result[key] = value
    return result


def _login():
    return OWNER["login"] or "viewer"


def _gql_field(type_name, payload, name, args, ctx):
    """Returns (value, is_object). On an unknown field records an error and
    returns (None, 'error')."""
    if name == "__typename":
        return type_name, False
    handler = _GQL_RESOLVERS.get(type_name, {}).get(name)
    if handler is None:
        ctx.errors.append({
            "message": "Field '%s' doesn't exist on type '%s'" % (name,
                                                                  type_name),
            "type": "UNDEFINED_FIELD",
        })
        return None, "error"
    return handler(payload, args, ctx)


def _repo_obj(repo):
    return ("Repository", repo)


def _issue_state_gql(issue):
    return "CLOSED" if issue["state"] == "closed" else "OPEN"


def _pull_state_gql(pull):
    if pull["merged"]:
        return "MERGED"
    return "CLOSED" if pull["state"] == "closed" else "OPEN"


def _pull_mergeable(repo, pull):
    if pull["merged"] or pull["state"] != "open":
        return "UNKNOWN"
    head_tip = repo.branch_oid(pull["head"])
    base_tip = repo.branch_oid(pull["base"])
    if head_tip is None or base_tip is None:
        return "UNKNOWN"
    mb = _merge_base(base_tip, head_tip)
    anc = _tree_files_of_commit(mb) if mb else {}
    _, conflict = _three_way_merge(anc, _tree_files_of_commit(head_tip),
                                    _tree_files_of_commit(base_tip))
    return "CONFLICTING" if conflict else "MERGEABLE"


_GQL_RESOLVERS = {
    "Query": {
        "viewer": lambda p, a, c: (("User", {"login": _login()}), True),
        "repository": lambda p, a, c: _gql_query_repository(a),
        "node": lambda p, a, c: (_gql_node(a.get("id")), True),
        "__type": lambda p, a, c: (_gql_type_obj(a.get("name")), True),
        "__schema": lambda p, a, c: (("__Schema", {}), True),
    },
    "Mutation": {
        "createIssue": lambda p, a, c: _gql_create_issue(a),
        "closeIssue": lambda p, a, c: _gql_close_issue(a),
        "createPullRequest": lambda p, a, c: _gql_create_pull(a),
        "mergePullRequest": lambda p, a, c: _gql_merge_pull(a),
        "addComment": lambda p, a, c: _gql_add_comment(a),
    },
    "User": {
        "login": lambda p, a, c: (p["login"], False),
        "id": lambda p, a, c: (node_id("User", p["login"]), False),
        "name": lambda p, a, c: (p["login"], False),
        "url": lambda p, a, c: ("http://forge.local/%s" % p["login"], False),
    },
    "__Type": {
        "name": lambda p, a, c: (p["name"], False),
        "kind": lambda p, a, c: (p["kind"], False),
        "description": lambda p, a, c: (None, False),
        "fields": lambda p, a, c: ([("__Field", {"name": f})
                                    for f in (p["fields"] or [])], True),
        "enumValues": lambda p, a, c: ([("__EnumValue", {"name": v})
                                        for v in (p["values"] or [])], True),
        "possibleTypes": lambda p, a, c: ([], True),
        "inputFields": lambda p, a, c: ([], True),
        "ofType": lambda p, a, c: (None, True),
    },
    "__Field": {
        "name": lambda p, a, c: (p["name"], False),
        "description": lambda p, a, c: (None, False),
        "type": lambda p, a, c: (None, True),
        "isDeprecated": lambda p, a, c: (False, False),
        "deprecationReason": lambda p, a, c: (None, False),
        "args": lambda p, a, c: ([], True),
    },
    "__EnumValue": {
        "name": lambda p, a, c: (p["name"], False),
        "description": lambda p, a, c: (None, False),
        "isDeprecated": lambda p, a, c: (False, False),
        "deprecationReason": lambda p, a, c: (None, False),
    },
    "__Schema": {
        "types": lambda p, a, c: ([_gql_type_obj(n) for n in GQL_SCHEMA],
                                  True),
        "queryType": lambda p, a, c: (_gql_type_obj("Query"), True),
        "mutationType": lambda p, a, c: (_gql_type_obj("Mutation"), True),
        "subscriptionType": lambda p, a, c: (None, True),
        "directives": lambda p, a, c: ([], True),
    },
    "Repository": {
        "id": lambda repo, a, c: (node_id("Repository", repo.name), False),
        "databaseId": lambda repo, a, c: (repo.id, False),
        "name": lambda repo, a, c: (repo.name, False),
        "nameWithOwner": lambda repo, a, c: (
            "%s/%s" % (repo.owner_login or _login(), repo.name), False),
        "owner": lambda repo, a, c: (
            ("User", {"login": repo.owner_login or _login()}), True),
        "description": lambda repo, a, c: (repo.description, False),
        "isPrivate": lambda repo, a, c: (repo.private, False),
        "isFork": lambda repo, a, c: (False, False),
        "defaultBranchRef": lambda repo, a, c: _gql_default_branch(repo),
        "viewerPermission": lambda repo, a, c: ("ADMIN", False),
        "hasIssuesEnabled": lambda repo, a, c: (True, False),
        "issue": lambda repo, a, c: _gql_repo_issue(repo, a),
        "issues": lambda repo, a, c: (_gql_repo_issues(repo, a), True),
        "pullRequest": lambda repo, a, c: _gql_repo_pull(repo, a),
        "pullRequests": lambda repo, a, c: (_gql_repo_pulls(repo, a), True),
        "createdAt": lambda repo, a, c: (_iso(1700000000 + repo.id), False),
        "updatedAt": lambda repo, a, c: (_iso(1700000000 + repo.id), False),
        "url": lambda repo, a, c: ("http://forge.local/r", False),
        "stargazerCount": lambda repo, a, c: (0, False),
        "forkCount": lambda repo, a, c: (0, False),
    },
    "Issue": {
        "id": lambda p, a, c: (node_id("Issue", p[0].name, p[1]["number"]),
                               False),
        "databaseId": lambda p, a, c: (p[1]["id"], False),
        "number": lambda p, a, c: (p[1]["number"], False),
        "title": lambda p, a, c: (p[1]["title"], False),
        "state": lambda p, a, c: (_issue_state_gql(p[1]), False),
        "body": lambda p, a, c: (p[1]["body"], False),
        "author": lambda p, a, c: (("User", {"login": _login()}), True),
        "createdAt": lambda p, a, c: (p[1]["created_at"], False),
        "updatedAt": lambda p, a, c: (p[1]["updated_at"], False),
        "closed": lambda p, a, c: (p[1]["state"] == "closed", False),
        "repository": lambda p, a, c: (_repo_obj(p[0]), True),
        "url": lambda p, a, c: ("http://forge.local/i", False),
    },
    "PullRequest": {
        "id": lambda p, a, c: (node_id("PullRequest", p[0].name,
                                       p[1]["number"]), False),
        "databaseId": lambda p, a, c: (p[1]["id"], False),
        "number": lambda p, a, c: (p[1]["number"], False),
        "title": lambda p, a, c: (p[1]["title"], False),
        "state": lambda p, a, c: (_pull_state_gql(p[1]), False),
        "body": lambda p, a, c: (p[1]["body"], False),
        "author": lambda p, a, c: (("User", {"login": _login()}), True),
        "merged": lambda p, a, c: (p[1]["merged"], False),
        "mergedAt": lambda p, a, c: (p[1]["merged_at"], False),
        "mergeable": lambda p, a, c: (_pull_mergeable(p[0], p[1]), False),
        "headRefName": lambda p, a, c: (p[1]["head"], False),
        "baseRefName": lambda p, a, c: (p[1]["base"], False),
        "headRefOid": lambda p, a, c: (
            p[0].branch_oid(p[1]["head"]) or ZERO_OID, False),
        "baseRefOid": lambda p, a, c: (
            p[0].branch_oid(p[1]["base"]) or ZERO_OID, False),
        "files": lambda p, a, c: (_gql_pull_files(p[0], p[1], a), True),
        "mergeCommit": lambda p, a, c: (
            ("Commit", {"oid": p[1]["merge_commit_sha"]})
            if p[1]["merge_commit_sha"] else None, True),
        "repository": lambda p, a, c: (_repo_obj(p[0]), True),
        "createdAt": lambda p, a, c: (p[1]["created_at"], False),
        "updatedAt": lambda p, a, c: (p[1]["updated_at"], False),
        "closed": lambda p, a, c: (p[1]["state"] == "closed", False),
        "url": lambda p, a, c: ("http://forge.local/p", False),
    },
    "IssueConnection": {
        "nodes": lambda p, a, c: (p["nodes"], True),
        "pageInfo": lambda p, a, c: (p["pageInfo"], True),
        "totalCount": lambda p, a, c: (p["totalCount"], False),
        "edges": lambda p, a, c: ([], True),
    },
    "PullRequestConnection": {
        "nodes": lambda p, a, c: (p["nodes"], True),
        "pageInfo": lambda p, a, c: (p["pageInfo"], True),
        "totalCount": lambda p, a, c: (p["totalCount"], False),
        "edges": lambda p, a, c: ([], True),
    },
    "PullRequestChangedFileConnection": {
        "nodes": lambda p, a, c: (p["nodes"], True),
        "pageInfo": lambda p, a, c: (p["pageInfo"], True),
        "totalCount": lambda p, a, c: (p["totalCount"], False),
    },
    "PullRequestChangedFile": {
        "path": lambda p, a, c: (p["filename"], False),
        "additions": lambda p, a, c: (p["additions"], False),
        "deletions": lambda p, a, c: (p["deletions"], False),
        "changeType": lambda p, a, c: (
            {"added": "ADDED", "removed": "DELETED"}.get(p["status"],
                                                         "MODIFIED"), False),
    },
    "PageInfo": {
        "hasNextPage": lambda p, a, c: (p["hasNextPage"], False),
        "hasPreviousPage": lambda p, a, c: (p["hasPreviousPage"], False),
        "startCursor": lambda p, a, c: (p["startCursor"], False),
        "endCursor": lambda p, a, c: (p["endCursor"], False),
    },
    "Ref": {
        "name": lambda p, a, c: (p["name"], False),
        "prefix": lambda p, a, c: ("refs/heads/", False),
    },
    "Commit": {
        "oid": lambda p, a, c: (p["oid"], False),
        "message": lambda p, a, c: ("", False),
        "messageHeadline": lambda p, a, c: ("", False),
    },
    "IssueComment": {
        "id": lambda p, a, c: (node_id("IssueComment", p[0], p[1]["id"]),
                               False),
        "databaseId": lambda p, a, c: (p[1]["id"], False),
        "body": lambda p, a, c: (p[1]["body"], False),
        "author": lambda p, a, c: (("User", {"login": _login()}), True),
        "createdAt": lambda p, a, c: (p[1]["created_at"], False),
        "updatedAt": lambda p, a, c: (p[1]["updated_at"], False),
        "url": lambda p, a, c: ("http://forge.local/c", False),
    },
    "CreateIssuePayload": {
        "issue": lambda p, a, c: (p, True),
        "clientMutationId": lambda p, a, c: (None, False),
    },
    "CloseIssuePayload": {
        "issue": lambda p, a, c: (p, True),
        "clientMutationId": lambda p, a, c: (None, False),
    },
    "CreatePullRequestPayload": {
        "pullRequest": lambda p, a, c: (p, True),
        "clientMutationId": lambda p, a, c: (None, False),
    },
    "MergePullRequestPayload": {
        "pullRequest": lambda p, a, c: (p, True),
        "clientMutationId": lambda p, a, c: (None, False),
    },
    "AddCommentPayload": {
        "commentEdge": lambda p, a, c: (("IssueCommentEdge", p), True),
        "subject": lambda p, a, c: (None, True),
        "clientMutationId": lambda p, a, c: (None, False),
    },
    "IssueCommentEdge": {
        "node": lambda p, a, c: (("IssueComment", p), True),
        "cursor": lambda p, a, c: (_cursor_for(0), False),
    },
}


def _gql_query_repository(args):
    repo = find_repo(args.get("owner"), args.get("name"))
    if repo is None:
        return None, True
    return _repo_obj(repo), True


def _gql_node(nid):
    key = NODE_IDS.get(nid or "")
    if key is None:
        return None
    kind, repo_name, number = key
    repo = REPOS.get(repo_name)
    if repo is None:
        return None
    if kind == "Repository":
        return _repo_obj(repo)
    if kind == "Issue" and number in repo.issues:
        return ("Issue", (repo, repo.issues[number]))
    if kind == "PullRequest" and number in repo.pulls:
        return ("PullRequest", (repo, repo.pulls[number]))
    return None


def _gql_default_branch(repo):
    if repo.head_oid() is None:
        return None, True
    return ("Ref", {"name": repo.default_branch}), True


def _gql_repo_issue(repo, args):
    issue = repo.issues.get(args.get("number"))
    if issue is None:
        return None, True
    return ("Issue", (repo, issue)), True


def _gql_repo_issues(repo, args):
    states = args.get("states")
    items = list(repo.issues.values())
    if states:
        wanted = {s.lower() for s in states}
        items = [i for i in items if i["state"] in wanted]
    order_by = args.get("orderBy") or {}
    direction = (order_by.get("direction") or "DESC").upper()
    items.sort(key=lambda i: i["number"], reverse=(direction != "ASC"))
    nodes = [("Issue", (repo, i)) for i in items]
    return _connection(nodes, args, "IssueConnection")


def _gql_repo_pull(repo, args):
    pull = repo.pulls.get(args.get("number"))
    if pull is None:
        return None, True
    return ("PullRequest", (repo, pull)), True


def _gql_repo_pulls(repo, args):
    states = args.get("states")
    items = list(repo.pulls.values())
    if states:
        wanted = {s.upper() for s in states}
        items = [p for p in items if _pull_state_gql(p) in wanted]
    items.sort(key=lambda p: p["number"], reverse=True)
    nodes = [("PullRequest", (repo, p)) for p in items]
    return _connection(nodes, args, "PullRequestConnection")


def _gql_pull_files(repo, pull, args):
    head_tip = repo.branch_oid(pull["head"])
    base_tip = repo.branch_oid(pull["base"])
    mb = _merge_base(base_tip, head_tip)
    files = _changed_files(repo, mb or base_tip, head_tip)
    nodes = [("PullRequestChangedFile", f) for f in files]
    return _connection(nodes, args, "PullRequestChangedFileConnection")


def _repo_by_node_id(nid):
    key = NODE_IDS.get(nid or "")
    if key is None or key[0] != "Repository":
        return None
    return REPOS.get(key[1])


def _gql_create_issue(args):
    inp = args.get("input") or {}
    repo = _repo_by_node_id(inp.get("repositoryId"))
    if repo is None:
        return None, True
    ISSUE_ID_SEQ[0] += 1
    number = repo.next_number
    repo.next_number += 1
    now = _iso(int(time.time()))
    issue = {"id": ISSUE_ID_SEQ[0], "number": number,
             "title": inp.get("title") or "", "body": inp.get("body") or "",
             "state": "open", "labels": [], "comments": [],
             "created_at": now, "updated_at": now,
             "node_id": node_id("Issue", repo.name, number)}
    repo.issues[number] = issue
    return ("CreateIssuePayload", ("Issue", (repo, issue))), True


def _gql_close_issue(args):
    inp = args.get("input") or {}
    node = _gql_node(inp.get("issueId"))
    if node is None or node[0] != "Issue":
        return None, True
    repo, issue = node[1]
    issue["state"] = "closed"
    issue["updated_at"] = _iso(int(time.time()))
    return ("CloseIssuePayload", ("Issue", (repo, issue))), True


def _gql_create_pull(args):
    inp = args.get("input") or {}
    repo = _repo_by_node_id(inp.get("repositoryId"))
    if repo is None:
        return None, True
    head = (inp.get("headRefName") or "").replace("refs/heads/", "")
    base = (inp.get("baseRefName") or repo.default_branch).replace(
        "refs/heads/", "")
    ISSUE_ID_SEQ[0] += 1
    number = repo.next_number
    repo.next_number += 1
    now = _iso(int(time.time()))
    pull = {"id": ISSUE_ID_SEQ[0], "number": number,
            "title": inp.get("title") or "", "body": inp.get("body") or "",
            "state": "open", "head": head, "base": base,
            "merged": False, "merged_at": None, "merge_commit_sha": None,
            "created_at": now, "updated_at": now,
            "node_id": node_id("PullRequest", repo.name, number)}
    repo.pulls[number] = pull
    return ("CreatePullRequestPayload", ("PullRequest", (repo, pull))), True


def _gql_merge_pull(args):
    inp = args.get("input") or {}
    node = _gql_node(inp.get("pullRequestId"))
    if node is None or node[0] != "PullRequest":
        return None, True
    repo, pull = node[1]
    method = (inp.get("mergeMethod") or "SQUASH").lower()
    _do_merge(repo, pull, method="merge" if method == "merge" else "squash")
    return ("MergePullRequestPayload", ("PullRequest", (repo, pull))), True


def _gql_add_comment(args):
    inp = args.get("input") or {}
    node = _gql_node(inp.get("subjectId"))
    if node is None:
        return None, True
    if node[0] == "Issue":
        repo, subject = node[1]
    elif node[0] == "PullRequest":
        repo, pull = node[1]
        subject = repo.issues.get(pull["number"])
        if subject is None:
            ISSUE_ID_SEQ[0] += 1
            subject = {"id": ISSUE_ID_SEQ[0], "number": pull["number"],
                       "title": pull["title"], "body": pull["body"],
                       "state": pull["state"], "labels": [], "comments": [],
                       "created_at": pull["created_at"],
                       "updated_at": pull["updated_at"],
                       "node_id": pull["node_id"]}
            repo.issues[pull["number"]] = subject
    else:
        return None, True
    COMMENT_SEQ[0] += 1
    comment = {"id": COMMENT_SEQ[0], "body": inp.get("body") or "",
               "user": {"login": _login(), "id": 1},
               "created_at": _iso(int(time.time())),
               "updated_at": _iso(int(time.time()))}
    subject["comments"].append(comment)
    return ("AddCommentPayload", (repo.name, comment)), True


def _gql_run_one(doc):
    try:
        operations, fragments = _GQLParser(_gql_tokens(doc.get("query") or "")
                                           ).parse_document()
    except GQLParseError as exc:
        return {"errors": [{"message": "Parse error: %s" % exc}]}
    if not operations:
        return {"errors": [{"message": "No operation found"}]}
    op = operations[0]
    op_name = doc.get("operationName")
    if op_name:
        for candidate in operations:
            if candidate["name"] == op_name:
                op = candidate
                break
    variables = dict(op["var_defs"])
    variables.update(doc.get("variables") or {})
    ctx = GQLContext(variables, fragments)
    root = ("Mutation" if op["type"] == "mutation" else "Query", {})
    data = _gql_exec(root, op["selection"], ctx)
    result = {"data": data}
    if ctx.errors:
        result["errors"] = ctx.errors
    return result


def graphql_dispatch(handler, method, parts, path, query, body):
    if parts != ["api", "graphql"] or method != "POST":
        return None
    try:
        doc = json.loads(body.decode("utf-8")) if body else None
    except Exception:
        handler.send_json(400, {"errors": [{"message": "Malformed JSON"}]})
        return True
    if isinstance(doc, list):
        handler.send_json(200, [_gql_run_one(d) for d in doc])
        return True
    if not isinstance(doc, dict):
        handler.send_json(400, {"errors": [{"message": "Bad request"}]})
        return True
    handler.send_json(200, _gql_run_one(doc))
    return True


# --------------------------------------------------------------------------
# MCP (POST /mcp, JSON-RPC 2.0 streamable HTTP)
# --------------------------------------------------------------------------

MCP_TOOLS = [
    {"name": "create_repo",
     "description": "Create a new repository for the authenticated user.",
     "inputSchema": {"type": "object",
                     "properties": {
                         "name": {"type": "string"},
                         "description": {"type": "string"},
                         "private": {"type": "boolean"}},
                     "required": ["name"]}},
    {"name": "get_repo",
     "description": "Get a repository by owner and name.",
     "inputSchema": {"type": "object",
                     "properties": {
                         "owner": {"type": "string"},
                         "repo": {"type": "string"}},
                     "required": ["owner", "repo"]}},
    {"name": "create_issue",
     "description": "Create an issue in a repository.",
     "inputSchema": {"type": "object",
                     "properties": {
                         "owner": {"type": "string"},
                         "repo": {"type": "string"},
                         "title": {"type": "string"},
                         "body": {"type": "string"}},
                     "required": ["owner", "repo", "title"]}},
    {"name": "list_issues",
     "description": "List issues in a repository.",
     "inputSchema": {"type": "object",
                     "properties": {
                         "owner": {"type": "string"},
                         "repo": {"type": "string"},
                         "state": {"type": "string"}},
                     "required": ["owner", "repo"]}},
    {"name": "create_pull_request",
     "description": "Create a pull request from a head branch to a base "
                    "branch.",
     "inputSchema": {"type": "object",
                     "properties": {
                         "owner": {"type": "string"},
                         "repo": {"type": "string"},
                         "title": {"type": "string"},
                         "body": {"type": "string"},
                         "head": {"type": "string"},
                         "base": {"type": "string"}},
                     "required": ["owner", "repo", "title", "head",
                                  "base"]}},
    {"name": "merge_pull_request",
     "description": "Merge a pull request.",
     "inputSchema": {"type": "object",
                     "properties": {
                         "owner": {"type": "string"},
                         "repo": {"type": "string"},
                         "pull_number": {"type": "integer"}},
                     "required": ["owner", "repo", "pull_number"]}},
]
MCP_TOOLS_JSON = json.dumps({"tools": MCP_TOOLS})


class _McpError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


def _mcp_result(obj):
    return {"content": [{"type": "text", "text": json.dumps(obj)}],
            "structuredContent": obj, "isError": False}


def _mcp_tool_error(message):
    return {"content": [{"type": "text", "text": message}], "isError": True}


def _mcp_call_tool(name, arguments):
    tool = next((t for t in MCP_TOOLS if t["name"] == name), None)
    if tool is None:
        raise _McpError(-32602, "Unknown tool: %s" % name)
    args = arguments or {}
    for required in tool["inputSchema"].get("required", []):
        if args.get(required) is None:
            raise _McpError(-32602, "Missing required argument: %s"
                            % required)
    if name == "create_repo":
        rname = args["name"]
        if rname in REPOS:
            return _mcp_tool_error("repository already exists")
        repo = create_repo(rname)
        repo.description = args.get("description") or ""
        repo.private = bool(args.get("private", False))
        if OWNER["login"]:
            repo.owner_login = OWNER["login"]
        return _mcp_result(repo_json(repo))
    repo = find_repo(args.get("owner"), args.get("repo"))
    if repo is None:
        return _mcp_tool_error("repository not found")
    if name == "get_repo":
        return _mcp_result(repo_json(repo))
    if name == "create_issue":
        ISSUE_ID_SEQ[0] += 1
        number = repo.next_number
        repo.next_number += 1
        now = _iso(int(time.time()))
        issue = {"id": ISSUE_ID_SEQ[0], "number": number,
                 "title": args.get("title") or "",
                 "body": args.get("body") or "",
                 "state": "open", "labels": [], "comments": [],
                 "created_at": now, "updated_at": now,
                 "node_id": node_id("Issue", repo.name, number)}
        repo.issues[number] = issue
        return _mcp_result(issue_json(repo, issue))
    if name == "list_issues":
        state = args.get("state") or "open"
        items = [i for i in repo.issues.values()
                 if state == "all" or i["state"] == state]
        items.sort(key=lambda i: i["number"])
        return _mcp_result({"issues": [issue_json(repo, i) for i in items]})
    if name == "create_pull_request":
        head = (args.get("head") or "").split(":")[-1]
        base = (args.get("base") or repo.default_branch).split(":")[-1]
        if repo.branch_oid(head) is None:
            return _mcp_tool_error("head branch does not exist")
        if repo.branch_oid(base) is None:
            return _mcp_tool_error("base branch does not exist")
        ISSUE_ID_SEQ[0] += 1
        number = repo.next_number
        repo.next_number += 1
        now = _iso(int(time.time()))
        pull = {"id": ISSUE_ID_SEQ[0], "number": number,
                "title": args.get("title") or "",
                "body": args.get("body") or "",
                "state": "open", "head": head, "base": base,
                "merged": False, "merged_at": None,
                "merge_commit_sha": None,
                "created_at": now, "updated_at": now,
                "node_id": node_id("PullRequest", repo.name, number)}
        repo.pulls[number] = pull
        return _mcp_result(pull_json(repo, pull))
    if name == "merge_pull_request":
        pull = repo.pulls.get(int(args["pull_number"]))
        if pull is None:
            return _mcp_tool_error("pull request not found")
        commit, err = _do_merge(repo, pull)
        if err is not None:
            return _mcp_tool_error("cannot merge: %s" % err)
        out = pull_json(repo, pull)
        out["sha"] = commit
        return _mcp_result(out)
    raise _McpError(-32602, "Unknown tool: %s" % name)


def _mcp_handle_one(req):
    """Returns (status, payload_dict_or_None). None payload = 202 no body."""
    if not isinstance(req, dict):
        return 400, {"jsonrpc": "2.0", "id": None,
                     "error": {"code": -32600, "message": "Invalid Request"}}
    rid = req.get("id")
    method = req.get("method") or ""
    params = req.get("params") or {}
    if rid is None:  # notification
        return 202, None
    try:
        if method == "server/discover":
            result = {
                "serverInfo": {"name": "forge", "version": "1.0.0"},
                "capabilities": {"tools": {"listChanged": False}},
                "supportedVersions": ["2026-07-28", "2025-11-25",
                                      "2025-06-18", "2025-03-26"],
            }
        elif method == "initialize":
            version = params.get("protocolVersion") or "2025-11-25"
            result = {
                "protocolVersion": version,
                "serverInfo": {"name": "forge", "version": "1.0.0"},
                "capabilities": {"tools": {"listChanged": False}},
            }
        elif method == "ping":
            result = {}
        elif method == "tools/list":
            return 200, {"jsonrpc": "2.0", "id": rid,
                         "result": json.loads(MCP_TOOLS_JSON)}
        elif method == "tools/call":
            result = _mcp_call_tool(params.get("name") or "",
                                    params.get("arguments") or {})
        else:
            raise _McpError(-32601, "Method not found: %s" % method)
    except _McpError as exc:
        return 200, {"jsonrpc": "2.0", "id": rid,
                     "error": {"code": exc.code, "message": exc.message}}
    return 200, {"jsonrpc": "2.0", "id": rid, "result": result}


def mcp_dispatch(handler, method, parts, path, query, body):
    if parts != ["mcp"] or method != "POST":
        return None
    try:
        req = json.loads(body.decode("utf-8")) if body else None
    except Exception:
        handler.send_json(400, {"jsonrpc": "2.0", "id": None,
                                "error": {"code": -32700,
                                          "message": "Parse error"}})
        return True
    if isinstance(req, list):
        payloads = []
        for item in req:
            status, payload = _mcp_handle_one(item)
            if payload is not None:
                payloads.append(payload)
        if not payloads:
            handler._send(202, b"", "application/json; charset=utf-8")
        else:
            handler.send_json(200, payloads)
        return True
    status, payload = _mcp_handle_one(req)
    if payload is None:
        handler._send(202, b"", "application/json; charset=utf-8")
    else:
        handler.send_json(status, payload)
    return True


if __name__ == "__main__":
    sys.exit(main())
