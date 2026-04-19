#!/usr/bin/env python3
"""Download Export Data from R2 for Frontend Build

Companion to the Eleventy-based public frontend. Connects to the
`zasqua-export` R2 bucket, downloads the descriptions index and every
per-fonds descriptions file listed there, concatenates them into the
single `descriptions.json` that the frontend template expects, and
pulls the sibling `repositories.json`, `entities.json`, `places.json`,
and per-description `children/*.json` fragments into the same output
directory so the 11ty build can run without any post-processing.

Runs as a plain Python script inside CI -- the frontend build pipeline
invokes it once per build. Uses `boto3` against R2's S3-compatible
endpoint so no R2-specific client is needed.

Version: v0.3.0

Original docblock kept below for environment setup details:

Connects to the zasqua-export R2 bucket, downloads the descriptions index
and per-fonds description files, concatenates them into a single
descriptions.json (matching the format the frontend expects), and downloads
repositories, entities, places, and children files.

Usage:
    python3 scripts/download-from-r2.py <bucket-name> <output-dir>

Example:
    python3 scripts/download-from-r2.py zasqua-export data/

Required environment variables:
    R2_ACCESS_KEY_ID      - Cloudflare R2 API token access key ID
    R2_SECRET_ACCESS_KEY  - Cloudflare R2 API token secret access key
    R2_ENDPOINT           - R2 S3-compatible endpoint URL

deploy.yml integration -- replace the "Download data from B2" step with:

    - name: Download data from R2
      env:
        R2_ACCESS_KEY_ID: ${{ secrets.R2_ACCESS_KEY_ID }}
        R2_SECRET_ACCESS_KEY: ${{ secrets.R2_SECRET_ACCESS_KEY }}
        R2_ENDPOINT: https://${{ secrets.CLOUDFLARE_ACCOUNT_ID }}.r2.cloudflarestorage.com
      run: python3 scripts/download-from-r2.py zasqua-export data/
"""

import json
import os
import sys

import boto3


def require_env(name: str) -> str:
    """Return the value of an environment variable or exit with an error."""
    val = os.environ.get(name)
    if not val:
        print(f"Error: missing required environment variable: {name}", file=sys.stderr)
        sys.exit(1)
    return val


def download_object(client, bucket: str, key: str, dest: str) -> int:
    """Download a single object from S3/R2 and return its size in bytes."""
    os.makedirs(os.path.dirname(dest) or ".", exist_ok=True)
    client.download_file(bucket, key, dest)
    size = os.path.getsize(dest)
    return size


def list_objects_with_prefix(client, bucket: str, prefix: str) -> list[str]:
    """List all object keys in a bucket matching a prefix."""
    keys: list[str] = []
    paginator = client.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
        for obj in page.get("Contents", []):
            keys.append(obj["Key"])
    return keys


def format_size(size_bytes: int) -> str:
    """Format byte count as human-readable string."""
    if size_bytes < 1024:
        return f"{size_bytes} B"
    elif size_bytes < 1024 * 1024:
        return f"{size_bytes / 1024:.1f} KB"
    else:
        return f"{size_bytes / (1024 * 1024):.1f} MB"


def main() -> None:
    if len(sys.argv) != 3:
        print("Usage: python3 scripts/download-from-r2.py <bucket-name> <output-dir>")
        print("Example: python3 scripts/download-from-r2.py zasqua-export data/")
        sys.exit(1)

    bucket = sys.argv[1]
    output_dir = sys.argv[2]

    access_key_id = require_env("R2_ACCESS_KEY_ID")
    secret_access_key = require_env("R2_SECRET_ACCESS_KEY")
    endpoint = require_env("R2_ENDPOINT")

    client = boto3.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=access_key_id,
        aws_secret_access_key=secret_access_key,
        region_name="auto",
    )

    os.makedirs(output_dir, exist_ok=True)
    os.makedirs(os.path.join(output_dir, "children"), exist_ok=True)

    print(f"Downloading export data from R2 bucket '{bucket}' to {output_dir}/\n")

    # Step 1: Download descriptions-index.json
    index_dest = os.path.join(output_dir, "descriptions-index.json")
    download_object(client, bucket, "descriptions-index.json", index_dest)

    with open(index_dest, "r") as f:
        index = json.load(f)

    fonds_entries = index.get("fonds", [])
    print(f"Found {len(fonds_entries)} fonds in descriptions-index.json")

    # Step 2: Download per-fonds description files and concatenate
    all_descriptions: list = []
    for entry in fonds_entries:
        key = entry["key"]
        fonds_dest = os.path.join(output_dir, key)
        size = download_object(client, bucket, key, fonds_dest)
        with open(fonds_dest, "r") as f:
            fonds_data = json.load(f)
        if isinstance(fonds_data, list):
            all_descriptions.extend(fonds_data)
            print(f"  {key}: {len(fonds_data)} descriptions ({format_size(size)})")

    # Write combined descriptions.json
    combined_path = os.path.join(output_dir, "descriptions.json")
    with open(combined_path, "w") as f:
        json.dump(all_descriptions, f)
    combined_size = os.path.getsize(combined_path)
    print(f"\nCombined descriptions.json: {len(all_descriptions)} records ({format_size(combined_size)})")

    # Step 3: Download other top-level files
    top_level_files = ["repositories.json", "entities.json", "places.json"]
    print()
    for filename in top_level_files:
        dest = os.path.join(output_dir, filename)
        try:
            size = download_object(client, bucket, filename, dest)
            print(f"Downloaded {filename} ({format_size(size)})")
        except client.exceptions.NoSuchKey:
            print(f"Skipped {filename} (not found in bucket)")

    # Step 4: Download children/*.json
    print("\nDownloading children files...")
    children_keys = list_objects_with_prefix(client, bucket, "children/")
    # Filter out the prefix-only key if present
    children_keys = [k for k in children_keys if k != "children/" and k.endswith(".json")]
    for key in children_keys:
        filename = os.path.basename(key)
        dest = os.path.join(output_dir, "children", filename)
        download_object(client, bucket, key, dest)
    print(f"Downloaded {len(children_keys)} children files")

    # Summary
    print(f"\nDone. Output directory: {output_dir}/")
    print(f"  descriptions.json: {len(all_descriptions)} records")
    print(f"  repositories.json: {'found' if os.path.exists(os.path.join(output_dir, 'repositories.json')) else 'missing'}")
    print(f"  entities.json: {'found' if os.path.exists(os.path.join(output_dir, 'entities.json')) else 'missing'}")
    print(f"  places.json: {'found' if os.path.exists(os.path.join(output_dir, 'places.json')) else 'missing'}")
    print(f"  children/: {len(children_keys)} files")


if __name__ == "__main__":
    main()
