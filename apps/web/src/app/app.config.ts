import {
  ApplicationConfig,
  EnvironmentProviders,
  inject,
  provideAppInitializer,
  provideZonelessChangeDetection,
} from '@angular/core';
import { provideRouter } from '@angular/router';
import { routes } from './app.routes';
import { AuthService } from './core/auth.service';
import {
  InMemoryWorkspaceGraphStore,
  WORKSPACE_GRAPH_STORE,
} from './workspace/workspace-graph-store.contract';

/**
 * Rehydrate the session before first render: on a hard refresh of a deep
 * authenticated route, `AuthService.refresh()` calls `whoami` so `user()` is set
 * before the shell paints (rather than only when `authGuard` later runs). A failed
 * `whoami` (401 → null) is swallowed so an anonymous load still boots to /login.
 */
export function provideSessionRehydration(): EnvironmentProviders {
  return provideAppInitializer(() =>
    inject(AuthService)
      .refresh()
      .catch(() => null),
  );
}

export const appConfig: ApplicationConfig = {
  providers: [
    provideZonelessChangeDetection(),
    provideRouter(routes),
    provideSessionRehydration(),
    // App-wide default so the console runs in any context; the workspace scope
    // overrides this with the canvas-backed GraphStoreWorkspaceAdapter.
    { provide: WORKSPACE_GRAPH_STORE, useClass: InMemoryWorkspaceGraphStore },
  ],
};
