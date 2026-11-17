#!/usr/bin/env python3
"""Build a reproducible unpacked-extension archive using only the standard library."""
import hashlib
import json
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

ROOT = Path(__file__).resolve().parents[1]
manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
if manifest["version"] != package["version"]:
    raise SystemExit("manifest.json and package.json versions must match")

files = {name: name for name in (
    "manifest.json", "background.js", "content.js", "page.js", "styles.css",
    "options.html", "options.js", "options.css", "LICENSE",
    *manifest["icons"].values(),
)}
files["docs/INSTALL.md"] = "INSTALL.md"
references = [manifest["background"]["service_worker"], manifest["action"]["default_popup"]]
for script in manifest["content_scripts"]:
    references.extend(script.get("js", []) + script.get("css", []))
if any(name not in files for name in references):
    raise SystemExit("Manifest references a file missing from the package")
for source in files:
    if not (ROOT / source).is_file():
        raise SystemExit(f"Missing package file: {source}")

output = ROOT / "dist" / "chaintrace-chrome.zip"
output.parent.mkdir(exist_ok=True)
with ZipFile(output, "w", compression=ZIP_DEFLATED, compresslevel=9) as archive:
    for source, destination in sorted(files.items()):
        info = ZipInfo(f"chaintrace-chrome/{destination}", date_time=(1980, 1, 1, 0, 0, 0))
        info.create_system = 3
        info.external_attr = 0o100644 << 16
        info.compress_type = ZIP_DEFLATED
        archive.writestr(info, (ROOT / source).read_bytes(), compresslevel=9)
with ZipFile(output) as archive:
    if archive.testzip() is not None:
        raise SystemExit("Package integrity check failed")
digest = hashlib.sha256(output.read_bytes()).hexdigest()
(output.parent / "SHA256SUMS").write_text(f"{digest}  {output.name}\n", encoding="utf-8")
print(f"Packaged ChainTrace v{manifest['version']}: {output.name} ({len(files)} files)")
print(f"SHA256 {digest}")
