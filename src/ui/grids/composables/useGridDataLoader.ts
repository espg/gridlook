import { onScopeDispose, ref, watch, type Ref } from "vue";
import type * as zarr from "zarrita";

import type { TSources } from "@/lib/types/GlobeTypes.ts";
import { useGlobeControlStore } from "@/store/store.ts";
import { useLog } from "@/ui/common/useLog.ts";

type TDataVar = zarr.Array<zarr.DataType, zarr.AsyncReadable>;
type TGlobeControlStore = ReturnType<typeof useGlobeControlStore>;
type TLogError = (maybeError: unknown, context?: string) => void;

type TLoaderState = {
  disposed: boolean;
  requestRevision: number;
  pendingUpdate: Ref<boolean>;
  updatingData: Ref<boolean>;
  // The level or the view window changed: the grid has to be prepared again
  // and its data has not been displayed yet.
  regrid: boolean;
};

type TGridDataLoaderOptions = {
  getDatasources: () => TSources | undefined;
  getDataVar: (
    varname: string,
    datasources: TSources
  ) => Promise<TDataVar | undefined>;
  fetchAndRenderData: (
    datavar: TDataVar,
    isCurrent: () => boolean,
    // Keep the frame on screen until the complete replacement is ready.
    stageDisplay: boolean
  ) => Promise<void>;
  clearHoverLookup: () => void;
  updateLandSeaMask: () => void | Promise<void>;
  updateColormap: () => void;
  prepareDatasource?: () => void | Promise<void>;
  // Grids that load only the view of a large level: whether this one can,
  // and whether the loaded window no longer covers the view.
  canLoadByView?: () => boolean;
  viewWindowStale?: () => boolean;
  resetDataVars?: () => void;
  refreshStreamlines?: (reuseCached?: boolean) => void | Promise<void>;
  suspendStreamlines?: () => void;
  scalarCache?: {
    clear: () => void;
    restoreScalar: () => Promise<boolean>;
  };
};

// eslint-disable-next-line max-lines-per-function
function createGetData(
  options: TGridDataLoaderOptions,
  store: TGlobeControlStore,
  state: TLoaderState,
  logError: TLogError
) {
  // eslint-disable-next-line max-lines-per-function
  return async function getData() {
    const datasources = options.getDatasources();
    if (!datasources) {
      return;
    }

    store.startLoading();
    state.requestRevision++;
    if (store.isStreamlineLayerEnabled()) {
      options.suspendStreamlines?.();
    }
    options.scalarCache?.clear();
    if (state.updatingData.value) {
      state.pendingUpdate.value = true;
      return;
    }

    state.updatingData.value = true;
    let shouldStopLoading = true;
    try {
      do {
        state.pendingUpdate.value = false;
        const revision = state.requestRevision;
        const isCurrent = () =>
          !state.disposed &&
          revision === state.requestRevision &&
          datasources === options.getDatasources();
        try {
          if (state.regrid) {
            // The grid stays mounted across a level or window swap: read
            // the new grid while the previous one stays on screen.
            options.clearHoverLookup();
            await options.prepareDatasource?.();
            if (!isCurrent()) {
              continue;
            }
            store.viewLoading = options.canLoadByView?.() ?? false;
          }
          const requestVarname = store.varnameSelector;
          const datavar = await options.getDataVar(requestVarname, datasources);
          if (state.disposed || datasources !== options.getDatasources()) {
            shouldStopLoading = false;
            return;
          }
          if (requestVarname !== store.varnameSelector) {
            state.pendingUpdate.value = true;
            continue;
          }
          if (datavar !== undefined && isCurrent()) {
            await options.fetchAndRenderData(datavar, isCurrent, state.regrid);
            if (isCurrent()) {
              state.regrid = false;
            }
          }
        } catch (error) {
          // A live source may roll over while an older timestep is loading.
          // If a newer update is already queued, retry it instead of dropping
          // the only notification for the newly available timestep.
          if (!state.disposed && !state.pendingUpdate.value) {
            logError(error, "Could not fetch data");
          }
        }
      } while (!state.disposed && state.pendingUpdate.value);
    } finally {
      state.updatingData.value = false;
      if (!state.disposed && shouldStopLoading) {
        // The renderer commits the displayed name and indices with its frame.
        store.stopLoading(false);
      }
    }
  };
}

function createDatasourceUpdate(
  options: TGridDataLoaderOptions,
  store: TGlobeControlStore,
  getData: () => Promise<void>
) {
  return async function datasourceUpdate() {
    options.resetDataVars?.();
    options.clearHoverLookup();

    if (options.getDatasources() === undefined) {
      return;
    }

    await options.prepareDatasource?.();
    store.viewLoading = options.canLoadByView?.() ?? false;
    await getData();
    await options.updateLandSeaMask();
    options.updateColormap();
  };
}

// eslint-disable-next-line max-lines-per-function
function registerGridDataLoaderWatches(
  options: TGridDataLoaderOptions,
  store: TGlobeControlStore,
  state: TLoaderState,
  getData: () => Promise<void>,
  logError: TLogError
) {
  watch(
    () => [...store.dimSlidersValues],
    async () => {
      if (store.isInitializingVariable) {
        // Variable changes remount the grid, so the initial dim write should
        // not trigger a second data request inside the fresh grid instance.
        store.isInitializingVariable = false;
        return;
      }
      await getData();
      options.updateColormap();
    }
  );
  async function regrid() {
    state.regrid = true;
    await getData();
    options.updateColormap();
  }
  watch(() => options.getDatasources()?.selectedLevel, regrid);
  watch(
    () => [store.viewFootprint, store.isVolumeLayerEnabled()],
    async () => {
      if (options.viewWindowStale?.()) {
        await regrid();
      }
    }
  );
  watch(
    () => store.streamlineSelectionRevision,
    async () => {
      try {
        if (state.updatingData.value) {
          await getData();
          return;
        }
        await options.refreshStreamlines?.();
      } catch (error) {
        logError(error, "Could not update vector components");
      }
    }
  );
  watch(
    () => store.streamlineScalarRevision,
    async () => {
      if (state.updatingData.value) {
        return;
      }
      try {
        if (store.streamlineMagnitudeDisplayed) {
          // A running build will display magnitude when it finishes.
          if (!store.streamlineLoading) {
            await options.refreshStreamlines?.(true);
          }
        } else {
          if (!(await options.scalarCache?.restoreScalar())) {
            await getData();
            options.updateColormap();
          }
        }
      } catch (error) {
        logError(error, "Could not change the displayed streamline scalar");
      }
    }
  );
  watch(
    () => store.isStreamlineLayerEnabled(),
    async (enabled) => {
      if (options.viewWindowStale?.()) {
        // Streamlines read the whole level, a view window does not hold it.
        await regrid();
        return;
      }
      if (!enabled) {
        store.setStreamlineMagnitudeDisplayed(false);
        options.suspendStreamlines?.();
        if (state.updatingData.value) {
          return;
        }
        if (!(await options.scalarCache?.restoreScalar())) {
          await getData();
          options.updateColormap();
        }
        return;
      }
      if (state.updatingData.value) {
        // Enabling must replace a build cancelled by an earlier disable.
        await getData();
        return;
      }
      try {
        await options.refreshStreamlines?.(true);
      } catch (error) {
        logError(error, "Could not enable vector streamlines");
      }
    }
  );
}

export function useGridDataLoader(options: TGridDataLoaderOptions) {
  const store = useGlobeControlStore();
  const { logError } = useLog();
  const state: TLoaderState = {
    disposed: false,
    requestRevision: 0,
    pendingUpdate: ref(false),
    updatingData: ref(false),
    regrid: false,
  };
  const getData = createGetData(options, store, state, logError);
  const datasourceUpdate = createDatasourceUpdate(options, store, getData);

  registerGridDataLoaderWatches(options, store, state, getData, logError);

  onScopeDispose(() => {
    state.disposed = true;
    state.pendingUpdate.value = false;
  });

  return {
    datasourceUpdate,
    getData,
  };
}
