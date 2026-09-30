#!/usr/bin/env python3
"""Run one CCFA gate over a research project and print its findings.

    python -I run_gate.py <yaml|review|ledger|submission|privacy> --root <project>

The gates check the CCFA contracts the skills write to: ccfa.yaml (the v0.4.0
schema in ccf-common/references/ccfa-yaml-contract.md), the canonical review
report (checked by the upstream validate_version_comparison.py --report, run
unchanged from ../upstream), the revision ledger (ccf-rebuttal-writer's
revision-ledger.md), the submission readiness record (ccf-submission-checker),
and machine paths in what gets submitted (the upstream check_path_privacy.py
patterns). The result is printed as the last line of standard output:

    {"findings": [{"severity": "error"|"warning", "message": ..., "file": ..., "line": ...}]}

Standard library only, except the yaml gate, which reads ccfa.yaml with the
platform Python's PyYAML.
"""
from __future__ import annotations

import json
import re
import runpy
import sys
import traceback
from pathlib import Path

HERE = Path(__file__).resolve().parent
UPSTREAM = HERE.parent / "upstream"

STATE_FILE = "ccfa.yaml"
REQUIRED_FIELDS = ["version", "project", "target_venue", "stage", "artifacts", "claims", "experiments",
                   "reviews", "revision_ledger", "submission_checks"]
MAPPING_FIELDS = ["project", "target_venue", "stage", "artifacts", "revision_ledger", "submission_checks"]
LIST_FIELDS = ["claims", "experiments", "reviews"]
DEFAULT_LEDGER = "reviews/revision-ledger.md"
DEFAULT_SUBMISSION_CHECKS = "submission/checks.md"
REVIEW_REPORTS = "ccfa-review-reports"

# Folders that hold no manuscript source: templates, working files, reports, environments.
NOT_MANUSCRIPT = {"template", "ccfa-workfiles", REVIEW_REPORTS, "reviews", "submission", "artifact", "talk",
                  "node_modules", "__pycache__", "venv", "env", "outputs"}
TEXT_SUFFIXES = {".tex", ".bib", ".cls", ".sty", ".bst", ".txt", ".md", ".py", ".yaml", ".yml", ".json",
                 ".cfg", ".toml", ".ini", ".sh", ".ipynb"}
PRIVACY_MAX_BYTES = 2 * 1024 * 1024

LEDGER_WORK = {"open", "planned", "drafted", "done", "blocked", "accepted_limit"}
LEDGER_COMPARATIVE = {"unresolved", "partially_resolved", "resolved", "not_applicable"}
LEDGER_FINISHED = {"done", "accepted_limit", "resolved", "not_applicable"}
SUBMISSION_STATUSES = {"pass", "fail", "not applicable", "not verified"}


def finding(severity, message, file=None, line=None):
    item = {"severity": severity, "message": message}
    if file:
        item["file"] = file
    if line:
        item["line"] = line
    return item


def rel(root, path):
    return path.relative_to(root).as_posix()


def walk(root, depth=4, suffixes=None, skip=frozenset()):
    """Project files up to `depth` folders deep, never inside hidden folders or the skipped ones."""
    found = []

    def visit(directory, level):
        try:
            entries = sorted(directory.iterdir())
        except OSError:
            return
        for entry in entries:
            if entry.is_dir():
                name = entry.name.lower()
                if level < depth and not name.startswith(".") and name not in skip:
                    visit(entry, level + 1)
            elif entry.is_file() and (suffixes is None or entry.suffix.lower() in suffixes):
                found.append(entry)

    visit(root, 0)
    return found


def load_state(root):
    """ccfa.yaml as a dict, or None when it is absent, unreadable or PyYAML is missing."""
    path = root / STATE_FILE
    if not path.is_file():
        return None
    try:
        import yaml
        data = yaml.safe_load(path.read_text(encoding="utf-8-sig"))
    except Exception:
        return None
    return data if isinstance(data, dict) else None


def section(state, name):
    """One mapping field of the state; empty when absent or not a mapping."""
    value = (state or {}).get(name)
    return value if isinstance(value, dict) else {}


def text_value(mapping, key):
    value = mapping.get(key)
    return value.strip() if isinstance(value, str) else ""


def project_root(root, state):
    """project.root, resolved against the folder holding ccfa.yaml."""
    value = text_value(section(state, "project"), "root")
    return (root / value).resolve() if value else root


def state_path(root, state, name, key, default):
    """A path the state records under name.key, resolved against project.root; the default otherwise."""
    return project_root(root, state) / (text_value(section(state, name), key) or default)


def manuscript_modified(root):
    """When the manuscript sources last changed: the newest .tex or .bib outside templates and reports."""
    files = walk(root, suffixes={".tex", ".bib"}, skip=NOT_MANUSCRIPT)
    return max((path.stat().st_mtime for path in files), default=0.0)


def markdown_table(text):
    """The first Markdown table in the text: (header cells, [(line number, cells)]), or None."""
    lines = text.splitlines()
    for index, line in enumerate(lines[:-1]):
        if not line.strip().startswith("|") or not re.match(r"^\s*\|?\s*:?-{3,}", lines[index + 1]):
            continue
        header = cells(line)
        rows = []
        for offset, row in enumerate(lines[index + 2:], start=index + 3):
            if not row.strip().startswith("|"):
                break
            rows.append((offset, cells(row)))
        return header, rows
    return None


def cells(line):
    return [cell.strip().strip("`").strip() for cell in re.split(r"(?<!\\)\|", line.strip().strip("|"))]


def column(header, *names):
    for index, cell in enumerate(header):
        label = re.sub(r"[`*]", "", cell).strip().casefold()
        if label in names or any(label.startswith(name + " ") or label.startswith(name + "/") for name in names):
            return index
    return None


# ── ccfa.yaml ──────────────────────────────────────────────────────────────


def machine_path(value):
    return bool(re.match(r"^(?:[A-Za-z]:[\\/]|/|\\\\|~)", value))


def yaml_gate(root):
    path = root / STATE_FILE
    if not path.is_file():
        return [finding("error", "No ccfa.yaml yet: scaffold the project (ccf-project-scaffolder copies the template and fills the project and venue)", STATE_FILE)]
    try:
        import yaml
    except ImportError:
        return [finding("error", "The platform Python has no PyYAML to read ccfa.yaml: reinstall it under Tools & models in the research settings", STATE_FILE)]
    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8-sig"))
    except yaml.YAMLError as error:
        mark = getattr(error, "problem_mark", None)
        return [finding("error", f"ccfa.yaml is not valid YAML: {getattr(error, 'problem', None) or error}", STATE_FILE, mark.line + 1 if mark else None)]
    if not isinstance(data, dict):
        return [finding("error", "ccfa.yaml must be a mapping of the v0.4.0 fields (copy the scaffolder's template)", STATE_FILE)]
    findings = []
    missing = [field for field in REQUIRED_FIELDS if field not in data]
    if missing:
        findings.append(finding("error", f"ccfa.yaml lacks required field(s): {', '.join(missing)}", STATE_FILE))
    if "version" in data and str(data["version"]) != "0.4.0":
        findings.append(finding("warning", f"ccfa.yaml says version {data['version']}; the contract is 0.4.0 — keep its fields rather than migrating them", STATE_FILE))
    for field in MAPPING_FIELDS:
        if field in data and not isinstance(data[field], dict):
            findings.append(finding("error", f"ccfa.yaml: {field} must be a mapping", STATE_FILE))
    for field in LIST_FIELDS:
        if field in data and not isinstance(data[field], list):
            findings.append(finding("error", f"ccfa.yaml: {field} must be a list", STATE_FILE))
    if isinstance(data.get("stage"), dict) and not text_value(data["stage"], "current"):
        findings.append(finding("error", "ccfa.yaml: stage.current must name the current stage", STATE_FILE))
    if isinstance(data.get("target_venue"), dict) and not str(data["target_venue"].get("name") or "").strip():
        findings.append(finding("warning", "ccfa.yaml names no target venue: the writer drafts against the NeurIPS guide as a stated assumption until one is chosen", STATE_FILE))
    # Every path the state records stays inside the project and never names the machine it was written on.
    paths = {"project.root": text_value(section(data, "project"), "root")}
    paths.update({f"artifacts.{key}": text_value(section(data, "artifacts"), key) for key in section(data, "artifacts")})
    paths.update({f"{name}.path": text_value(section(data, name), "path") for name in ("revision_ledger", "submission_checks")})
    if isinstance(data.get("last_monitoring_report"), str):
        paths["last_monitoring_report"] = data["last_monitoring_report"].strip()
    base = project_root(root, data)
    for key, value in paths.items():
        if not value:
            continue
        if machine_path(value):
            findings.append(finding("error", f"ccfa.yaml stores a machine path in {key}: record it relative to the project", STATE_FILE))
            continue
        target = (root / value if key == "project.root" else base / value).resolve()
        if target != root and root not in target.parents:
            findings.append(finding("error", f"ccfa.yaml: {key} = {value} points outside the project", STATE_FILE))
        elif key in {"artifacts.manuscript", "artifacts.bibliography"} and not target.is_file():
            findings.append(finding("warning", f"ccfa.yaml: {key} is {value}, which does not exist yet — create it or record where it is", STATE_FILE))
    return findings


# ── review report ──────────────────────────────────────────────────────────


def scope_field(text, *labels):
    """A `Label: value` line of the report's scope block (bold and list markers allowed)."""
    names = "|".join(re.escape(label) for label in labels)
    match = re.search(rf"^\s*(?:[-*]\s+)?(?:\*\*)?(?:{names})(?:\*\*)?\s*[:：]\s*(?:\*\*)?\s*([^\n|]+)", text, re.IGNORECASE | re.MULTILINE)
    return match[1].strip().strip("`*").strip() if match else ""


def report_profile(text):
    """The validator's (mode, detail, rubric, no_scores) as the report's scope block declares them."""
    mode = scope_field(text, "Mode", "Review mode", "模式", "评审模式").lower().replace(" ", "-")
    mode = next((known for known in ("version-comparison", "scientific", "writing", "full") if mode.startswith(known)), mode or "scientific")
    detail = scope_field(text, "Detail", "Detail level", "详略", "详细程度").lower()
    detail = "brief" if detail.startswith("brief") or detail.startswith("简") else "detailed"
    rubric = scope_field(text, "Rubric", "评分标准").lower()
    rubric = "generic-7" if not rubric or rubric.startswith("generic-7") or rubric.startswith("writing") or rubric.startswith("inherited") else "external"
    scores = scope_field(text, "Scores", "评分").lower()
    return mode, detail, rubric, scores in {"none", "no", "no scores", "无", "不评分"}


def open_findings(validator, text):
    """(id, title, severity, status) for every finding record the report defines."""
    visible = validator["_visible_markdown"](text)
    plain = validator["_plain"]
    records = []
    for match in re.finditer(rf"^### ({validator['ISSUE_ID']})\s*[:：—-]\s*(\S.*)$", visible, re.MULTILINE):
        block = re.split(r"^#{2,3} ", visible[match.end():], maxsplit=1, flags=re.MULTILINE)[0]
        fields = {}
        for line in block.splitlines():
            line = plain(re.sub(r"^\s*[-*]\s+", "", line))
            if not re.search(r"[:：]", line):
                continue
            label, value = re.split(r"[:：]", line, maxsplit=1)
            names = [name.casefold().strip() for name in label.split("/")]
            for key in ("severity", "status"):
                chinese = validator["FINDING_FIELDS"][key]
                if names in ([key], [chinese], [key, chinese], [chinese, key]):
                    fields[key] = plain(value)
        records.append((match[1], match[2].strip(), fields.get("severity", ""), fields.get("status", "")))
    return records


def review_gate(root):
    folder = root / REVIEW_REPORTS
    reports = sorted(folder.glob("*.md")) if folder.is_dir() else []
    if not reports:
        return [finding("error", f"No review report yet: review the paper with ccf-paper-reviewer and save {REVIEW_REPORTS}/<paper-slug>-<venue>-review.md")]
    validator = runpy.run_path(str(UPSTREAM / "ccf-paper-reviewer/scripts/validate_version_comparison.py"))
    findings = []
    for report in reports:
        name = rel(root, report)
        text = report.read_text(encoding="utf-8-sig")
        if scope_field(text, "Template", "模板") != "ccfa-review-1":
            findings.append(finding("warning", f"{name} does not declare Template: ccfa-review-1 in its scope block, so its format was not checked", name))
        else:
            mode, detail, rubric, no_scores = report_profile(text)
            for error in validator["validate_report"](text, mode=mode, detail=detail, no_scores=no_scores, rubric=rubric):
                findings.append(finding("error", f"Review report ({mode}, {detail}): {error}", name))
        for identity, title, severity, status in open_findings(validator, text):
            if severity in {"critical", "major"} and status in {"unresolved", "partially_resolved"}:
                findings.append(finding("error", f"Open {severity} finding {identity} ({status}): {title} — fix it through its owner, then re-review", name))
    return findings


# ── revision ledger ────────────────────────────────────────────────────────


def ledger_gate(root):
    path = state_path(root, load_state(root), "revision_ledger", "path", DEFAULT_LEDGER)
    name = rel(root, path) if root in path.parents else DEFAULT_LEDGER
    if not path.is_file():
        return [finding("error", f"No revision ledger yet: parse the reviews into {name} (ccf-rebuttal-writer, revision-ledger mode)", name)]
    table = markdown_table(path.read_text(encoding="utf-8-sig"))
    if table is None:
        return [finding("error", "The revision ledger holds no Markdown table: one row per reviewer comment (see revision-ledger.md)", name)]
    header, rows = table
    ident, status, location = column(header, "comment_id", "id"), column(header, "status"), column(header, "location", "action / location")
    missing = [label for label, index in (("comment_id", ident), ("status", status), ("location", location)) if index is None]
    if missing:
        return [finding("error", f"The revision ledger lacks column(s): {', '.join(missing)}", name)]
    findings = []
    if not rows:
        findings.append(finding("error", "The revision ledger has no rows: record every reviewer comment", name))
    seen = set()
    for line, row in rows:
        if len(row) != len(header):
            findings.append(finding("error", "Ledger row width differs from its header", name, line))
            continue
        comment, state, where = row[ident], row[status].lower(), row[location]
        if not comment:
            findings.append(finding("error", "Ledger row without a comment_id", name, line))
        elif comment in seen:
            findings.append(finding("error", f"Duplicate comment_id {comment}", name, line))
        seen.add(comment)
        if state not in LEDGER_WORK | LEDGER_COMPARATIVE:
            findings.append(finding("error", f"{comment}: status '{row[status]}' is not one of {', '.join(sorted(LEDGER_WORK | LEDGER_COMPARATIVE))}", name, line))
        elif state not in LEDGER_FINISHED:
            findings.append(finding("error", f"{comment} is still {state}: make the change (or record accepted_limit with its reason) and update the row", name, line))
        if state in {"done", "resolved"} and not where:
            findings.append(finding("error", f"{comment} is marked {state} without a manuscript location", name, line))
    return findings


# ── submission readiness ───────────────────────────────────────────────────


def submission_gate(root):
    path = state_path(root, load_state(root), "submission_checks", "path", DEFAULT_SUBMISSION_CHECKS)
    name = rel(root, path) if root in path.parents else DEFAULT_SUBMISSION_CHECKS
    if not path.is_file():
        return [finding("error", f"No submission check record yet: run ccf-submission-checker and write {name}", name)]
    text = path.read_text(encoding="utf-8-sig")
    findings = []
    if not re.search(r"https?://\S+", scope_field(text, "Official rules", "Official rule URL", "官方规则")):
        findings.append(finding("error", "The submission record names no official rule URL (Official rules: <url>)", name))
    if not re.search(r"\d{4}-\d{2}-\d{2}", scope_field(text, "Checked", "Date checked", "检查日期")):
        findings.append(finding("error", "The submission record has no check date (Checked: YYYY-MM-DD)", name))
    table = markdown_table(text)
    if table is None:
        return findings + [finding("error", "The submission record holds no checklist table (Check | Status | Evidence | Fix)", name)]
    header, rows = table
    check, status, fix = column(header, "check", "item"), column(header, "status"), column(header, "fix", "required fix")
    if check is None or status is None:
        return findings + [finding("error", "The submission checklist needs Check and Status columns", name)]
    if not rows:
        findings.append(finding("error", "The submission checklist has no rows", name))
    for line, row in rows:
        if len(row) != len(header):
            findings.append(finding("error", "Checklist row width differs from its header", name, line))
            continue
        state = row[status].lower()
        what = row[check] or f"row {line}"
        if state not in SUBMISSION_STATUSES:
            findings.append(finding("error", f"{what}: status '{row[status]}' is not pass, fail, not applicable or not verified", name, line))
        elif state == "fail":
            remedy = row[fix] if fix is not None and row[fix] else "fix it and check again"
            findings.append(finding("error", f"Submission check fails: {what} — {remedy}", name, line))
        elif state == "not verified":
            findings.append(finding("warning", f"Not verified: {what}", name, line))
    if path.stat().st_mtime < manuscript_modified(root):
        findings.append(finding("warning", "The submission checks predate the latest manuscript changes: check the affected items again", name))
    return findings


# ── machine paths in what is submitted ─────────────────────────────────────


def privacy_gate(root):
    patterns = runpy.run_path(str(UPSTREAM / "ccf-common/scripts/check_path_privacy.py"))["default_patterns"]()
    scanned = []
    for folder in ("code", "submission", "artifact"):
        if (root / folder).is_dir():
            scanned += walk(root / folder, depth=4, suffixes=TEXT_SUFFIXES, skip=NOT_MANUSCRIPT - {"submission", "artifact"})
    scanned += walk(root, depth=3, suffixes={".tex", ".bib"}, skip=NOT_MANUSCRIPT | {"code"})
    findings = []
    for path in dict.fromkeys(scanned):
        try:
            if path.stat().st_size > PRIVACY_MAX_BYTES:
                continue
            text = path.read_text(encoding="utf-8-sig")
        except (OSError, UnicodeDecodeError):
            continue
        for number, line in enumerate(text.splitlines(), start=1):
            for label, pattern in patterns:
                if pattern.search(line):
                    findings.append(finding("error", f"A local path ({label}) would reveal the author: use a project-relative path", rel(root, path), number))
                    break
    return findings


GATES = {
    "yaml": yaml_gate,
    "review": review_gate,
    "ledger": ledger_gate,
    "submission": submission_gate,
    "privacy": privacy_gate,
}


def main(argv):
    if len(argv) < 3 or argv[0] not in GATES or "--root" not in argv or argv.index("--root") + 1 >= len(argv):
        print(json.dumps({"findings": [finding("error", f"usage: run_gate.py <{'|'.join(GATES)}> --root <project>")]}))
        return 2
    root = Path(argv[argv.index("--root") + 1]).resolve()
    try:
        findings = GATES[argv[0]](root)
    except Exception as error:  # a broken input file reports as a finding, never as a crash
        tail = traceback.format_exception_only(type(error), error)[-1].strip()
        findings = [finding("error", f"The {argv[0]} gate could not read the project: {tail}")]
    print(json.dumps({"findings": findings}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
