#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from typing import Any
from urllib.parse import quote


DEFAULT_BASE_URL = "http://dev.tellhowsoft.com/DefaultCollection"


class TfsError(RuntimeError):
    pass


def env_or_fail(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise TfsError(f"missing environment variable: {name}")
    return value


def base_url() -> str:
    return (os.getenv("TFS_BASE_URL") or DEFAULT_BASE_URL).rstrip("/")


def run_curl(method: str, url: str, *, data: str | None = None, content_type: str | None = None) -> dict[str, Any]:
    username = env_or_fail("TFS_USERNAME")
    password = env_or_fail("TFS_PASSWORD")

    cmd = [
        "curl",
        "-sS",
        "--ntlm",
        "-u",
        f"{username}:{password}",
        "-X",
        method,
        url,
        "-H",
        "Accept: application/json",
        "-w",
        "\n%{http_code}",
    ]
    if content_type:
        cmd.extend(["-H", f"Content-Type: {content_type}"])
    if data is not None:
        cmd.extend(["--data-binary", data])

    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise TfsError(proc.stderr.strip() or "curl failed")

    if "\n" not in proc.stdout:
        raise TfsError("unexpected curl output")
    body, status = proc.stdout.rsplit("\n", 1)
    http_code = int(status.strip())

    try:
      parsed = json.loads(body) if body.strip() else None
    except json.JSONDecodeError:
      parsed = body

    if http_code >= 400:
        message = parsed if isinstance(parsed, str) else json.dumps(parsed, ensure_ascii=False)
        raise TfsError(f"HTTP {http_code}: {message[:1000]}")

    return {"status": http_code, "body": parsed}


def print_json(value: Any) -> None:
    print(json.dumps(value, ensure_ascii=False, indent=2))


def list_projects(_: argparse.Namespace) -> None:
    url = f"{base_url()}/_apis/projects?api-version=2.0"
    result = run_curl("GET", url)["body"]
    projects = [
        {
            "id": row.get("id"),
            "name": row.get("name"),
            "state": row.get("state"),
            "description": row.get("description"),
            "lastUpdateTime": row.get("lastUpdateTime"),
        }
        for row in result.get("value", [])
    ]
    print_json({"count": result.get("count", len(projects)), "projects": projects})


def connection_data(_: argparse.Namespace) -> None:
    url = (
        f"{base_url()}/_apis/connectionData"
        "?connectOptions=includeServices&lastChangeId=-1&lastChangeId64=-1"
    )
    result = run_curl("GET", url)["body"]
    summary = {
        "authenticatedUser": result.get("authenticatedUser", {}).get("properties", {}).get("Account", {}).get("$value"),
        "authorizedUser": result.get("authorizedUser", {}).get("properties", {}).get("Account", {}).get("$value"),
        "deploymentType": result.get("deploymentType"),
        "webApplicationRelativeDirectory": result.get("webApplicationRelativeDirectory"),
        "accessMappings": result.get("locationServiceData", {}).get("accessMappings", []),
    }
    print_json(summary)


def list_work_item_types(args: argparse.Namespace) -> None:
    url = f"{base_url()}/{quote(args.project)}/_apis/wit/workitemtypes?api-version=2.0"
    result = run_curl("GET", url)["body"]
    types = [
        {
            "name": row.get("name"),
            "referenceName": row.get("referenceName"),
            "description": row.get("description"),
            "color": row.get("color"),
            "isDisabled": row.get("isDisabled"),
        }
        for row in result.get("value", [])
    ]
    print_json({"count": result.get("count", len(types)), "workItemTypes": types})


def get_work_item(args: argparse.Namespace) -> None:
    fields = args.fields or ",".join([
        "System.Id",
        "System.WorkItemType",
        "System.Title",
        "System.State",
        "System.AssignedTo",
        "System.CreatedBy",
        "System.CreatedDate",
        "System.ChangedBy",
        "System.ChangedDate",
        "System.AreaPath",
        "System.IterationPath",
    ])
    url = (
        f"{base_url()}/{quote(args.project)}/_apis/wit/workitems/{args.id}"
        f"?api-version=2.0&fields={quote(fields, safe=',')}"
    )
    result = run_curl("GET", url)["body"]
    print_json(result)


def query_wiql(args: argparse.Namespace) -> None:
    url = f"{base_url()}/{quote(args.project)}/_apis/wit/wiql?api-version=2.0"
    payload = json.dumps({"query": args.wiql}, ensure_ascii=False)
    result = run_curl("POST", url, data=payload, content_type="application/json")["body"]
    work_items = result.get("workItems", [])
    if args.expand and work_items:
        ids = ",".join(str(row["id"]) for row in work_items[: args.expand])
        expand_url = (
            f"{base_url()}/{quote(args.project)}/_apis/wit/workitems"
            f"?ids={ids}&api-version=2.0&fields={quote(args.fields, safe=',')}"
        )
        expanded = run_curl("GET", expand_url)["body"]
        print_json({"queryType": result.get("queryType"), "count": len(work_items), "workItems": expanded.get("value", [])})
        return
    print_json({"queryType": result.get("queryType"), "count": len(work_items), "workItems": work_items})


def create_work_item(args: argparse.Namespace) -> None:
    ops: list[dict[str, Any]] = [
        {"op": "add", "path": "/fields/System.Title", "value": args.title},
    ]
    if args.description:
        ops.append({"op": "add", "path": "/fields/System.Description", "value": args.description})
    if args.assigned_to:
        ops.append({"op": "add", "path": "/fields/System.AssignedTo", "value": args.assigned_to})
    if args.area_path:
        ops.append({"op": "add", "path": "/fields/System.AreaPath", "value": args.area_path})
    if args.iteration_path:
        ops.append({"op": "add", "path": "/fields/System.IterationPath", "value": args.iteration_path})
    if args.activity:
        ops.append({"op": "add", "path": "/fields/Microsoft.VSTS.Common.Activity", "value": args.activity})
    if args.original_estimate is not None:
        ops.append({"op": "add", "path": "/fields/Microsoft.VSTS.Scheduling.OriginalEstimate", "value": args.original_estimate})
    if args.remaining_work is not None:
        ops.append({"op": "add", "path": "/fields/Microsoft.VSTS.Scheduling.RemainingWork", "value": args.remaining_work})
    if args.target_date:
        ops.append({"op": "add", "path": "/fields/Microsoft.VSTS.Scheduling.TargetDate", "value": args.target_date})
    if args.parent_id is not None:
        ops.append({
            "op": "add",
            "path": "/relations/-",
            "value": {
                "rel": "System.LinkTypes.Hierarchy-Reverse",
                "url": f"{base_url()}/_apis/wit/workItems/{args.parent_id}",
                "attributes": {"comment": f"父项工作项 {args.parent_id}"},
            },
        })

    url = f"{base_url()}/{quote(args.project)}/_apis/wit/workitems/${quote(args.type)}?api-version=2.0"
    result = run_curl(
        "POST",
        url,
        data=json.dumps(ops, ensure_ascii=False),
        content_type="application/json-patch+json",
    )["body"]
    print_json(result)


def update_work_item(args: argparse.Namespace) -> None:
    ops: list[dict[str, Any]] = []
    if args.title:
        ops.append({"op": "add", "path": "/fields/System.Title", "value": args.title})
    if args.state:
        ops.append({"op": "add", "path": "/fields/System.State", "value": args.state})
    if args.assigned_to:
        ops.append({"op": "add", "path": "/fields/System.AssignedTo", "value": args.assigned_to})
    if args.history:
        ops.append({"op": "add", "path": "/fields/System.History", "value": args.history})
    if args.description:
        ops.append({"op": "add", "path": "/fields/System.Description", "value": args.description})
    if args.activity:
        ops.append({"op": "add", "path": "/fields/Microsoft.VSTS.Common.Activity", "value": args.activity})
    if args.original_estimate is not None:
        ops.append({"op": "add", "path": "/fields/Microsoft.VSTS.Scheduling.OriginalEstimate", "value": args.original_estimate})
    if args.remaining_work is not None:
        ops.append({"op": "add", "path": "/fields/Microsoft.VSTS.Scheduling.RemainingWork", "value": args.remaining_work})
    if args.target_date:
        ops.append({"op": "add", "path": "/fields/Microsoft.VSTS.Scheduling.TargetDate", "value": args.target_date})
    if not ops:
        raise TfsError("no update fields provided")

    url = f"{base_url()}/{quote(args.project)}/_apis/wit/workitems/{args.id}?api-version=2.0"
    result = run_curl(
        "PATCH",
        url,
        data=json.dumps(ops, ensure_ascii=False),
        content_type="application/json-patch+json",
    )["body"]
    print_json(result)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Tellhow TFS client via NTLM + REST API")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("list-projects", help="List projects in DefaultCollection")
    p.set_defaults(func=list_projects)

    p = sub.add_parser("connection-data", help="Show connection and deployment summary")
    p.set_defaults(func=connection_data)

    p = sub.add_parser("list-work-item-types", help="List work item types for a project")
    p.add_argument("--project", default="RSMP")
    p.set_defaults(func=list_work_item_types)

    p = sub.add_parser("get-work-item", help="Get work item detail by id")
    p.add_argument("--project", default="RSMP")
    p.add_argument("--id", required=True, type=int)
    p.add_argument("--fields", help="Comma-separated field list")
    p.set_defaults(func=get_work_item)

    p = sub.add_parser("query-wiql", help="Run a WIQL query")
    p.add_argument("--project", default="RSMP")
    p.add_argument("--wiql", required=True)
    p.add_argument("--expand", type=int, default=0, help="Expand first N ids into work item detail")
    p.add_argument(
        "--fields",
        default="System.Id,System.WorkItemType,System.Title,System.State,System.AssignedTo,System.ChangedDate",
        help="Field list used when --expand is set",
    )
    p.set_defaults(func=query_wiql)

    p = sub.add_parser("create-work-item", help="Create a work item")
    p.add_argument("--project", default="RSMP")
    p.add_argument("--type", required=True, help="Work item type, e.g. Bug")
    p.add_argument("--title", required=True)
    p.add_argument("--description")
    p.add_argument("--assigned-to")
    p.add_argument("--area-path")
    p.add_argument("--iteration-path")
    p.add_argument("--activity", help="Activity field value, e.g. 开发")
    p.add_argument("--original-estimate", type=float, help="Original estimate")
    p.add_argument("--remaining-work", type=float, help="Remaining work")
    p.add_argument("--target-date", help="Target date, e.g. 2026-03-31T16:00:00Z")
    p.add_argument("--parent-id", type=int, help="Parent work item id")
    p.set_defaults(func=create_work_item)

    p = sub.add_parser("update-work-item", help="Update a work item")
    p.add_argument("--project", default="RSMP")
    p.add_argument("--id", required=True, type=int)
    p.add_argument("--title")
    p.add_argument("--state")
    p.add_argument("--assigned-to")
    p.add_argument("--history")
    p.add_argument("--description")
    p.add_argument("--activity", help="Activity field value, e.g. 开发")
    p.add_argument("--original-estimate", type=float, help="Original estimate")
    p.add_argument("--remaining-work", type=float, help="Remaining work")
    p.add_argument("--target-date", help="Target date, e.g. 2026-03-31T16:00:00Z")
    p.set_defaults(func=update_work_item)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    try:
        args.func(args)
    except TfsError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
