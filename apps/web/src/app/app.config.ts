import { ApplicationConfig, provideZonelessChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';
import { routes } from './app.routes';
import {
  InMemoryWorkspaceGraphStore,
  WORKSPACE_GRAPH_STORE,
} from './workspace/workspace-graph-store.contract';

export const appConfig: ApplicationConfig = {
  providers: [
    provideZonelessChangeDetection(),
    provideRouter(routes),
    // App-wide default so the console runs in any context; the workspace scope
    // overrides this with the canvas-backed GraphStoreWorkspaceAdapter.
    { provide: WORKSPACE_GRAPH_STORE, useClass: InMemoryWorkspaceGraphStore },
  ],
};
