"""
Object-level authorization for the Python file Lambdas:
  - cdk/lambda/getFilesFunction/getFilesFunction.py
  - cdk/lambda/getProfilePictures/getProfilePictures.py
  - cdk/lambda/deleteFile/deleteFile.py
  - cdk/lambda/generatePreSignedURL/generatePreSignedURL.py

Each module is loaded from its own directory with its Lambda-layer imports
(psycopg2, rsa, powertools, cors_helper) stubbed, and its DB / S3 / signing
calls replaced by in-memory fakes. Handlers are invoked end to end.
"""
import importlib.util
import json
import os
import sys
import types

import pytest

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_LAMBDA_DIR = os.path.join(_REPO_ROOT, "cdk", "lambda")

GROUP = "11111111-1111-4111-8111-111111111111"
OTHER_GROUP = "22222222-2222-4222-8222-222222222222"
PERSONA = "33333333-3333-4333-8333-333333333333"
OTHER_PERSONA = "44444444-4444-4444-8444-444444444444"

STUDENT = "student@example.edu"
OUTSIDER = "outsider@example.edu"
INSTRUCTOR = "instructor@example.edu"           # instructs GROUP
OTHER_INSTRUCTOR = "instructor2@example.edu"    # global instructor role, instructs OTHER_GROUP only
ADMIN = "admin@example.edu"


# ── Fake database ───────────────────────────────────────────────────────────

class World:
    """Users, roles, group instructors, enrollments and personas."""

    def __init__(self):
        self.roles = {
            STUDENT: ["student"],
            OUTSIDER: ["student"],
            INSTRUCTOR: ["instructor"],
            OTHER_INSTRUCTOR: ["instructor"],
            ADMIN: ["admin"],
        }
        self.group_instructors = {(INSTRUCTOR, GROUP), (OTHER_INSTRUCTOR, OTHER_GROUP)}
        self.enrollments = {(STUDENT, GROUP)}
        self.personas = {(PERSONA, GROUP), (OTHER_PERSONA, OTHER_GROUP)}
        self.fail = False


class FakeCursor:
    def __init__(self, world):
        self.world = world
        self._row = None
        self.executed = []

    def execute(self, sql, params):
        for value in params:
            assert str(value) not in sql, "caller value interpolated into SQL"
        self.executed.append((sql, params))
        if self.world.fail:
            raise RuntimeError("db down")
        self._row = self._answer(" ".join(sql.split()), params)

    def _is_instructor(self, email, group):
        return (email, group) in self.world.group_instructors

    def _answer(self, sql, params):
        w = self.world
        # getFilesFunction.get_file_access
        if "AS persona_in_group" in sql:
            group, _, _, _, persona, persona_group, email = params
            if email not in w.roles:
                return None
            return (
                "admin" in w.roles[email],
                self._is_instructor(email, group),
                (email, group) in w.enrollments,
                (persona, persona_group) in w.personas,
            )
        # getProfilePictures.has_group_access
        if sql.startswith('SELECT 1 FROM "users" u') and '"group_instructors"' in sql:
            email, group = params[0], params[1]
            if email not in w.roles:
                return None
            ok = "admin" in w.roles[email] or self._is_instructor(email, group) or (email, group) in w.enrollments
            return (1,) if ok else None
        # deleteFile.verify_instructor_ownership (admin or instructor enrollment)
        if sql.startswith('SELECT 1 FROM "users" u') and "enrollment_type = 'instructor'" in sql:
            email, group = params
            ok = "admin" in w.roles.get(email, []) or self._is_instructor(email, group)
            return (1,) if ok else None
        # deleteFile.persona_in_group
        if sql.startswith('SELECT 1 FROM "personas"'):
            return (1,) if tuple(params) in w.personas else None
        # getProfilePictures.fetch_persona_ids
        if "SELECT persona_id FROM personas" in sql:
            self._rows = [(p,) for p, g in w.personas if g == params[0]]
            return None
        # getFilesFunction.get_file_metadata_from_db
        if 'FROM "persona_data"' in sql and sql.startswith("SELECT"):
            return None
        # deleteFile writes
        if sql.startswith("DELETE") or "langchain_pg_collection" in sql:
            return None
        raise AssertionError(f"unexpected query: {sql}")

    def fetchone(self):
        return self._row

    def fetchall(self):
        return getattr(self, "_rows", [])

    def close(self):
        pass


class FakeConnection:
    def __init__(self, world):
        self.world = world
        self.closed = False
        self.cursors = []

    def cursor(self):
        cur = FakeCursor(self.world)
        self.cursors.append(cur)
        return cur

    def commit(self):
        pass

    def rollback(self):
        pass

    def all_sql(self):
        return [" ".join(sql.split()) for cur in self.cursors for sql, _ in cur.executed]


# ── Module loading with Lambda-layer stubs ──────────────────────────────────

class _Logger:
    def inject_lambda_context(self, fn=None, **_kwargs):
        # Supports both @inject_lambda_context and @inject_lambda_context(log_event=True)
        return fn if fn is not None else (lambda f: f)

    def __getattr__(self, _name):
        return lambda *a, **kw: None


def _stub_modules(monkeypatch):
    powertools = types.ModuleType("aws_lambda_powertools")
    powertools.Logger = _Logger
    cors = types.ModuleType("cors_helper")
    cors.get_cors_headers = lambda event: {}
    rsa = types.ModuleType("rsa")
    rsa.PrivateKey = types.SimpleNamespace(load_pkcs1=lambda *_: None)
    rsa.sign = lambda *_: b""
    psycopg2 = types.ModuleType("psycopg2")
    psycopg2.connect = lambda *_a, **_kw: None
    for name, mod in {
        "aws_lambda_powertools": powertools,
        "cors_helper": cors,
        "rsa": rsa,
        "psycopg2": psycopg2,
    }.items():
        monkeypatch.setitem(sys.modules, name, mod)

    boto3 = types.ModuleType("boto3")
    boto3.client = lambda *_a, **_kw: types.SimpleNamespace()
    monkeypatch.setitem(sys.modules, "boto3", boto3)


def _load(monkeypatch, folder, filename):
    _stub_modules(monkeypatch)
    for key, value in {
        "REGION": "us-east-1",
        "AWS_DEFAULT_REGION": "us-east-1",
        "BUCKET": "bucket",
        "SM_DB_CREDENTIALS": "secret",
        "RDS_PROXY_ENDPOINT": "proxy",
        "CLOUDFRONT_DOMAIN": "cdn.example.com",
        "CLOUDFRONT_KEY_PAIR_ID": "KEY",
        "SM_CLOUDFRONT_PRIVATE_KEY": "pk",
    }.items():
        monkeypatch.setenv(key, value)
    path = os.path.join(_LAMBDA_DIR, folder, filename)
    spec = importlib.util.spec_from_file_location(f"_under_test_{folder}", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _event(email, **query):
    return {"requestContext": {"authorizer": {"email": email}}, "queryStringParameters": query}


@pytest.fixture
def world():
    return World()


# ── getFilesFunction ────────────────────────────────────────────────────────

@pytest.fixture
def get_files(monkeypatch, world):
    mod = _load(monkeypatch, "getFilesFunction", "getFilesFunction.py")
    conn = FakeConnection(world)
    monkeypatch.setattr(mod, "connect_to_db", lambda: conn)
    listed = []

    def fake_list(_bucket, prefix):
        listed.append(prefix)
        return ["key.pdf"] if prefix.endswith("answer_key/") else []

    monkeypatch.setattr(mod, "list_files_in_s3_prefix", fake_list)
    monkeypatch.setattr(mod, "generate_presigned_url", lambda _b, key: f"https://signed/{key}")
    mod._listed = listed
    return mod


def _files(mod, email, group=GROUP, persona=PERSONA):
    return mod.lambda_handler(_event(email, simulation_group_id=group, persona_id=persona), None)


def test_get_files_instructor_of_other_group_is_denied(get_files):
    """A global 'instructor' role used to pass for every group."""
    resp = _files(get_files, OTHER_INSTRUCTOR)
    assert resp["statusCode"] == 403
    assert get_files._listed == []


def test_get_files_outsider_is_denied(get_files):
    assert _files(get_files, OUTSIDER)["statusCode"] == 403


def test_get_files_missing_identity_is_denied(get_files):
    assert _files(get_files, "")["statusCode"] == 403


def test_get_files_foreign_persona_is_denied_even_for_admin(get_files):
    for email in (STUDENT, INSTRUCTOR, ADMIN):
        assert _files(get_files, email, persona=OTHER_PERSONA)["statusCode"] == 403
    assert get_files._listed == []


def test_get_files_enrolled_student_sees_no_answer_keys(get_files):
    resp = _files(get_files, STUDENT)
    assert resp["statusCode"] == 200
    assert json.loads(resp["body"])["answer_key_files"] == {}


@pytest.mark.parametrize("email", [INSTRUCTOR, ADMIN])
def test_get_files_group_staff_see_answer_keys(get_files, email):
    resp = _files(get_files, email)
    assert resp["statusCode"] == 200
    assert "key.pdf" in json.loads(resp["body"])["answer_key_files"]


def test_get_files_instructor_enrolled_as_student_elsewhere_sees_no_answer_keys(get_files, world):
    """Answer-key visibility follows the caller's role in THIS group, not their global role."""
    world.enrollments.add((OTHER_INSTRUCTOR, GROUP))
    resp = _files(get_files, OTHER_INSTRUCTOR)
    assert resp["statusCode"] == 200
    assert json.loads(resp["body"])["answer_key_files"] == {}


def test_get_files_fails_closed_on_db_error(get_files, world):
    world.fail = True
    assert _files(get_files, ADMIN)["statusCode"] == 403


# ── getProfilePictures ──────────────────────────────────────────────────────

@pytest.fixture
def get_pics(monkeypatch, world):
    mod = _load(monkeypatch, "getProfilePictures", "getProfilePictures.py")
    conn = FakeConnection(world)
    monkeypatch.setattr(mod, "connect_to_db", lambda: conn)
    signed = []

    def fake_sign(_bucket, key):
        signed.append(key)
        return f"https://signed/{key}"

    monkeypatch.setattr(mod, "generate_presigned_url", fake_sign)
    mod._signed = signed
    return mod


def _pics(mod, email, group=GROUP):
    return mod.lambda_handler(_event(email, simulation_group_id=group), None)


@pytest.mark.parametrize("email", [OUTSIDER, OTHER_INSTRUCTOR, ""])
def test_profile_pictures_denied_without_group_access(get_pics, email):
    resp = _pics(get_pics, email)
    assert resp["statusCode"] == 403
    assert get_pics._signed == []


def test_profile_pictures_denied_when_authorizer_context_missing(get_pics):
    resp = get_pics.lambda_handler({"queryStringParameters": {"simulation_group_id": GROUP}}, None)
    assert resp["statusCode"] == 403
    assert get_pics._signed == []


@pytest.mark.parametrize("email", [STUDENT, INSTRUCTOR, ADMIN])
def test_profile_pictures_allowed_with_group_access(get_pics, email):
    resp = _pics(get_pics, email)
    assert resp["statusCode"] == 200
    assert list(json.loads(resp["body"])) == [PERSONA]
    assert all(key.startswith(f"{GROUP}/") for key in get_pics._signed)


def test_profile_pictures_fails_closed_on_db_error(get_pics, world):
    world.fail = True
    assert _pics(get_pics, ADMIN)["statusCode"] == 403


# ── deleteFile ──────────────────────────────────────────────────────────────

@pytest.fixture
def delete_file(monkeypatch, world):
    mod = _load(monkeypatch, "deleteFile", "deleteFile.py")
    conn = FakeConnection(world)
    monkeypatch.setattr(mod, "connect_to_db", lambda: conn)
    deleted = []
    monkeypatch.setattr(
        mod, "s3", types.SimpleNamespace(delete_objects=lambda **kw: deleted.append(kw) or {})
    )
    mod._conn = conn
    mod._deleted = deleted
    return mod


def _delete(mod, email, group=GROUP, persona=PERSONA):
    return mod.lambda_handler(
        _event(
            email,
            simulation_group_id=group,
            persona_id=persona,
            file_name="notes",
            file_type="pdf",
            folder_type="documents",
        ),
        None,
    )


def test_delete_file_foreign_persona_is_denied_before_any_delete(delete_file):
    """persona_data is keyed by persona_id only, so a group-B persona must be rejected."""
    resp = _delete(delete_file, INSTRUCTOR, persona=OTHER_PERSONA)
    assert resp["statusCode"] == 403
    assert delete_file._deleted == []
    assert not any(sql.startswith("DELETE") for sql in delete_file._conn.all_sql())


def test_delete_file_instructor_of_group_can_delete(delete_file):
    resp = _delete(delete_file, INSTRUCTOR)
    assert resp["statusCode"] == 200
    assert delete_file._deleted[0]["Delete"]["Objects"] == [{"Key": f"{GROUP}/{PERSONA}/documents/notes.pdf"}]


def test_delete_file_non_instructor_is_denied(delete_file):
    assert _delete(delete_file, OTHER_INSTRUCTOR)["statusCode"] == 403
    assert delete_file._deleted == []


# ── generatePreSignedURL ────────────────────────────────────────────────────

@pytest.fixture
def presign(monkeypatch, world):
    mod = _load(monkeypatch, "generatePreSignedURL", "generatePreSignedURL.py")
    conn = FakeConnection(world)
    monkeypatch.setattr(mod, "connect_to_db", lambda: conn)
    signed = []

    def fake_post(**kw):
        signed.append(kw["Key"])
        return {"url": "https://bucket.s3", "fields": {"key": kw["Key"]}}

    monkeypatch.setattr(mod, "s3", types.SimpleNamespace(generate_presigned_post=fake_post))
    mod._signed = signed
    return mod


def _presign(mod, email, group=GROUP, persona=PERSONA, folder="documents"):
    return mod.lambda_handler(
        _event(
            email,
            simulation_group_id=group,
            patient_id=persona,
            file_name="notes",
            file_type="pdf",
            folder_type=folder,
        ),
        None,
    )


@pytest.mark.parametrize("email", [INSTRUCTOR, ADMIN])
def test_presign_foreign_persona_is_denied(presign, email):
    """Uploading into a group-B persona would poison its persona-keyed RAG collection."""
    resp = _presign(presign, email, persona=OTHER_PERSONA)
    assert resp["statusCode"] == 403
    assert presign._signed == []


@pytest.mark.parametrize("folder", ["documents", "info", "answer_key", "profile_picture"])
def test_presign_instructor_of_group_gets_scoped_key(presign, folder):
    file_type = "png" if folder == "profile_picture" else "pdf"
    resp = presign.lambda_handler(
        _event(
            INSTRUCTOR,
            simulation_group_id=GROUP,
            patient_id=PERSONA,
            file_name="notes",
            file_type=file_type,
            folder_type=folder,
        ),
        None,
    )
    assert resp["statusCode"] == 200
    assert presign._signed == [f"{GROUP}/{PERSONA}/{folder}/notes.{file_type}"]


def test_presign_instructor_of_other_group_is_denied(presign):
    assert _presign(presign, OTHER_INSTRUCTOR)["statusCode"] == 403
    assert presign._signed == []


@pytest.mark.parametrize(
    "group,persona",
    [
        (GROUP, f"{OTHER_GROUP}/{OTHER_PERSONA}"),
        (GROUP, "../x"),
        (f"{GROUP}/{OTHER_GROUP}", PERSONA),
        ("not-a-uuid", PERSONA),
    ],
)
def test_presign_rejects_non_uuid_ids(presign, group, persona):
    resp = _presign(presign, ADMIN, group=group, persona=persona)
    assert resp["statusCode"] == 400
    assert presign._signed == []


def test_presign_fails_closed_on_db_error(presign, world):
    world.fail = True
    assert _presign(presign, ADMIN)["statusCode"] == 403
    assert presign._signed == []


# "_page" is reserved for ingestion's per-page temp keys (finding f-0eb77eb0).
@pytest.mark.parametrize("file_name", ["notes.pdf_page_x", "notes_page", "a_page_1"])
def test_presign_rejects_page_sentinel_in_file_name(presign, file_name):
    resp = presign.lambda_handler(
        _event(
            INSTRUCTOR,
            simulation_group_id=GROUP,
            patient_id=PERSONA,
            file_name=file_name,
            file_type="pdf",
            folder_type="documents",
        ),
        None,
    )
    assert resp["statusCode"] == 400
    assert presign._signed == []


@pytest.mark.parametrize("file_name", ["notes", "Page 1 notes", "pages-overview", "my_paper"])
def test_presign_allows_names_without_page_sentinel(presign, file_name):
    resp = presign.lambda_handler(
        _event(
            INSTRUCTOR,
            simulation_group_id=GROUP,
            patient_id=PERSONA,
            file_name=file_name,
            file_type="pdf",
            folder_type="documents",
        ),
        None,
    )
    assert resp["statusCode"] == 200
