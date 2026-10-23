#!/usr/bin/env python3
"""Idempotent GitHub P1-02 governance setup; Python 3.10+ and authenticated gh."""
import argparse
import json
import re
import subprocess
from pathlib import Path

PROJECT_ID = re.compile(r"^\[(P[0-7]-\d{2})\]\s")
PHASE_TITLES = {
    "P0": "Vorprüfung",
    "P1": "Basis",
    "P2": "Redaktion",
    "P3": "Medien",
    "P4": "Render",
    "P5": "Upload",
    "P6": "QA",
    "P7": "Pilot",
}
STATUSES = ["Backlog", "Ready", "In Progress", "In Review", "Blocked", "Done"]


def project_id(title):
    found = PROJECT_ID.match(title or "")
    return found.group(1) if found else None


def validate_backlog(data):
    if not isinstance(data, dict) or not isinstance(data.get("issues"), list):
        raise ValueError("Backlog requires an issues array.")
    result = {}
    for item in data["issues"]:
        identifier = item.get("id")
        if not identifier or identifier in result or project_id(item.get("title")) != identifier:
            raise ValueError("Duplicate or invalid issue ID: " + str(identifier))
        if item.get("milestone") not in PHASE_TITLES:
            raise ValueError("Invalid phase: " + identifier)
        if not isinstance(item.get("labels"), list):
            raise ValueError("Missing labels: " + identifier)
        result[identifier] = item
    return result


def label_definitions(backlog):
    names = {"type:task", "type:bug", "type:spike"}
    names.update(f"priority:P{i}" for i in range(4))
    names.update(f"phase:P{i}" for i in range(8))
    names.update("status:" + s for s in STATUSES)
    for issue in backlog.values():
        names.update(issue["labels"])
    output = {}
    for name in sorted(names):
        prefix = name.split(":", 1)[0]
        color = {
            "type": "0E8A16",
            "area": "1D76DB",
            "priority": "D93F0B",
            "phase": "5319E7",
            "status": "C2E0C6",
        }.get(prefix, "D4C5F9")
        output[name] = {
            "name": name,
            "color": color,
            "description": "VideoNews Studio: " + name,
        }
    return output


def index_remote_issues(items):
    indexed = {}
    for issue in items:
        if issue.get("pull_request"):
            continue
        identifier = project_id(issue.get("title"))
        if identifier:
            if identifier in indexed:
                raise ValueError("Duplicate remote ID: " + identifier)
            indexed[identifier] = issue
    return indexed


def plan_issue_update(item, remote, milestones):
    current_labels = {x["name"] for x in remote.get("labels", [])}
    wanted_labels = set(item["labels"])
    if not any(name.startswith("status:") for name in current_labels):
        wanted_labels.add(
            "status:In Progress" if item["id"] in ("P1-01", "P1-02")
            else "status:Backlog"
        )
    additions = sorted(wanted_labels - current_labels)
    current_ms = remote.get("milestone")
    target = milestones.get(item["milestone"])
    add_milestone = target if current_ms is None else None
    return additions, add_milestone


def api(path, method="GET", payload=None):
    cmd = ["gh", "api", path, "-H", "Accept: application/vnd.github+json"]
    if method != "GET":
        cmd += ["--method", method, "--input", "-"]
    completed = subprocess.run(
        cmd, input=json.dumps(payload) if payload is not None else None,
        text=True, capture_output=True, check=False
    )
    if completed.returncode:
        raise RuntimeError(
            "GitHub API " + method + " " + path + " failed: " + completed.stderr[-700:]
        )
    return json.loads(completed.stdout) if completed.stdout.strip() else None


def pages(endpoint):
    result = []
    for number in range(1, 1000):
        separator = "&" if "?" in endpoint else "?"
        batch = api(endpoint + separator + "per_page=100&page=" + str(number))
        if not isinstance(batch, list):
            raise ValueError("Expected list from " + endpoint)
        result.extend(batch)
        if len(batch) < 100:
            return result
    raise RuntimeError("Refusing unbounded GitHub pagination.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True, help="GitHub repository owner/name")
    parser.add_argument("--file", default="backlog/issues.json")
    parser.add_argument("--apply", action="store_true", help="Create/update missing metadata")
    args = parser.parse_args()
    if not re.fullmatch(r"[A-Za-z0-9-]+/[A-Za-z0-9._-]+", args.repo):
        parser.error("--repo must be owner/name")
    source = validate_backlog(json.loads(Path(args.file).read_text(encoding="utf-8")))
    root = "repos/" + args.repo
    remote_labels = {x["name"] for x in pages(root + "/labels")}
    remote_milestones = pages(root + "/milestones?state=all")
    milestone_by_phase = {}
    for phase in PHASE_TITLES:
        matching = [ms for ms in remote_milestones if ms["title"] == phase + " " + PHASE_TITLES[phase]]
        if matching:
            milestone_by_phase[phase] = matching[0]["number"]
    # Capture the current state before mutation to avoid overwriting existing metadata.
    remote_issues = index_remote_issues(pages(root + "/issues?state=all"))
    absent = sorted(set(source) - set(remote_issues))
    if absent:
        raise RuntimeError("Missing GitHub Issues: " + ", ".join(absent) + "; run P1-01 import first.")

    mode = "APPLY" if args.apply else "DRY RUN"
    print(mode + " | repo=" + args.repo + " | issues=" + str(len(source)))
    for label in label_definitions(source).values():
        if label["name"] not in remote_labels:
            print("LABEL + " + label["name"])
            if args.apply:
                api(root + "/labels", "POST", label)
                remote_labels.add(label["name"])
    for phase, title in PHASE_TITLES.items():
        if phase not in milestone_by_phase:
            print("MILESTONE + " + phase + " " + title)
            if args.apply:
                ms = api(root + "/milestones", "POST", {
                    "title": phase + " " + title,
                    "description": "VideoNews Studio phase " + phase,
                })
                milestone_by_phase[phase] = ms["number"]
    changes = 0
    for identifier, item in source.items():
        remote = remote_issues[identifier]
        label_additions, milestone_number = plan_issue_update(item, remote, milestone_by_phase)
        needs_milestone = remote.get("milestone") is None
        if label_additions or needs_milestone:
            changes += 1
            print("ISSUE #" + str(remote["number"]) + " " + identifier
                  + " labels=" + ",".join(label_additions)
                  + " milestone=" + (item["milestone"] if needs_milestone else "unchanged"))
            if args.apply:
                if label_additions:
                    api(root + "/issues/" + str(remote["number"]) + "/labels",
                        "POST", {"labels": label_additions})
                if needs_milestone:
                    api(root + "/issues/" + str(remote["number"]), "PATCH",
                        {"milestone": milestone_by_phase[item["milestone"]]})
    print("Issues needing updates: " + str(changes))
    if not args.apply:
        print("No changes made. Use --apply after reviewing the plan.")
    else:
        print("Changes submitted. Re-run without --apply to verify.")


if __name__ == "__main__":
    main()
