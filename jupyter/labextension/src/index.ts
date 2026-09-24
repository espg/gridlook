/**
 * jupyterlab-gridlook: "Open with Gridlook" for the JupyterLab file browser.
 *
 * Ported from the index.ts attached to d70-t/gridlook#214. The one change:
 * the viewer is the SPA served by the gridlook-jupyter server extension at
 * `<base>/gridlook/`, not a copy in this extension's static dir — served from
 * there it gets jupyter's ordinary CSP (a document under `/files/` or a
 * labextension's static dir is sandboxed with an opaque origin), and one
 * wheel carries one build of the viewer.
 */

import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin,
} from "@jupyterlab/application";
import { ICommandPalette } from "@jupyterlab/apputils";
import { IFileBrowserFactory } from "@jupyterlab/filebrowser";
import { ILauncher } from "@jupyterlab/launcher";
import { ServerConnection } from "@jupyterlab/services";
import { LabIcon } from "@jupyterlab/ui-components";
import { Widget } from "@lumino/widgets";

import gridlookSvg from "../style/gridlook.svg";

import { viewerSrc } from "./urls";

const CommandIDs = {
  /** Open the viewer, optionally on `args.path` (a contents-API path). */
  open: "gridlook:open",
  /** Open the viewer on the file browser's selected directory / .zarr entry. */
  openWithGridlook: "gridlook:open-with-gridlook",
} as const;

export const gridlookIcon = new LabIcon({
  name: "gridlook:icon",
  svgstr: gridlookSvg,
});

/** A main-area tab holding the viewer in an iframe. */
class GridlookViewer extends Widget {
  constructor(baseUrl: string, path?: string) {
    super();
    const name = path ? path.split("/").pop() || path : "";
    this.id = `gridlook-view-${(path ?? "").replace(/[^a-zA-Z0-9_-]/g, "-")}`;
    this.addClass("jp-GridlookViewer");
    this.title.label = name ? `Gridlook: ${name}` : "Gridlook";
    this.title.caption = path ?? "Gridlook viewer";
    this.title.icon = gridlookIcon;
    this.title.closable = true;

    const iframe = document.createElement("iframe");
    iframe.src = viewerSrc(baseUrl, path);
    iframe.title = this.title.label;
    // Reserved seam: camera/params (d70-t#133) and bearer tokens (d70-t#56)
    // would travel parent <-> iframe by postMessage on this element.
    this.node.appendChild(iframe);
  }
}

/** The single selected file-browser item, if it is a directory or .zarr. */
function selectedStore(fileBrowser: IFileBrowserFactory) {
  const browser = fileBrowser.tracker.currentWidget;
  if (!browser) {
    return undefined;
  }
  const items = Array.from(browser.selectedItems());
  if (items.length !== 1) {
    return undefined;
  }
  const item = items[0];
  return item.type === "directory" || item.name.endsWith(".zarr")
    ? item
    : undefined;
}

function activate(
  app: JupyterFrontEnd,
  fileBrowser: IFileBrowserFactory,
  launcher: ILauncher | null,
  palette: ICommandPalette | null
): void {
  const { baseUrl } = ServerConnection.makeSettings();

  app.commands.addCommand(CommandIDs.open, {
    label: "Gridlook",
    caption: "Open the gridlook viewer",
    icon: gridlookIcon,
    execute: (args) => {
      const path = typeof args.path === "string" ? args.path : undefined;
      const viewer = new GridlookViewer(baseUrl, path);
      app.shell.add(viewer, "main");
      app.shell.activateById(viewer.id);
    },
  });

  app.commands.addCommand(CommandIDs.openWithGridlook, {
    label: "Open with Gridlook",
    caption: "Open the selected directory or zarr store in the gridlook viewer",
    icon: gridlookIcon,
    isVisible: () => selectedStore(fileBrowser) !== undefined,
    execute: () => {
      const item = selectedStore(fileBrowser);
      if (item) {
        return app.commands.execute(CommandIDs.open, { path: item.path });
      }
    },
  });

  app.contextMenu.addItem({
    command: CommandIDs.openWithGridlook,
    selector: ".jp-DirListing-item",
    rank: 100,
  });

  launcher?.add({ command: CommandIDs.open, category: "Other", rank: 1 });
  palette?.addItem({ command: CommandIDs.open, category: "Gridlook" });
}

const plugin: JupyterFrontEndPlugin<void> = {
  id: "jupyterlab-gridlook:plugin",
  description: "Open zarr stores from the file browser in the gridlook viewer.",
  autoStart: true,
  requires: [IFileBrowserFactory],
  optional: [ILauncher, ICommandPalette],
  activate,
};

export default plugin;
