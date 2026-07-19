"""Hatchling build hook: build the Vite SPA at the repo root and package dist/ as static/.

Wheel builds need either a pre-populated gridlook_jupyter/static/ (index.html present)
or node/npm on PATH plus the frontend sources one directory up. Editable installs skip
the hook — point GridlookProxy.static_dir at a dev dist/ instead.
"""

import shutil
import subprocess
from pathlib import Path

from hatchling.builders.hooks.plugin.interface import BuildHookInterface


class ViteBuildHook(BuildHookInterface):
    PLUGIN_NAME = "custom"

    def initialize(self, version, build_data):
        if self.target_name != "wheel" or version == "editable":
            return
        pkg_root = Path(self.root)
        static = pkg_root / "gridlook_jupyter" / "static"
        if (static / "index.html").exists():
            self.app.display_info(f"gridlook-jupyter: packaging pre-built SPA from {static}")
            return

        repo_root = pkg_root.parent
        if not (repo_root / "package.json").exists():
            raise RuntimeError(
                "gridlook-jupyter: gridlook_jupyter/static/ is empty and the frontend "
                "sources are not present one directory up (no package.json). Build from "
                "the gridlook repo checkout, or pre-populate gridlook_jupyter/static/ "
                "with a built dist/. Refusing to ship a wheel without the SPA."
            )
        npm = shutil.which("npm")
        if npm is None:
            raise RuntimeError(
                "gridlook-jupyter: gridlook_jupyter/static/ is empty and npm is not on "
                "PATH. Install node >= 24 and retry, or pre-populate "
                "gridlook_jupyter/static/ with a built dist/. Refusing to ship a wheel "
                "without the SPA."
            )

        self.app.display_info("gridlook-jupyter: running npm ci && npm run build")
        subprocess.run([npm, "ci"], cwd=repo_root, check=True)
        subprocess.run([npm, "run", "build"], cwd=repo_root, check=True)
        dist = repo_root / "dist"
        if not (dist / "index.html").exists():
            raise RuntimeError(f"gridlook-jupyter: npm run build produced no {dist}/index.html")
        if static.exists():
            shutil.rmtree(static)
        shutil.copytree(dist, static)
        self.app.display_info(f"gridlook-jupyter: packaged {dist} -> {static}")
