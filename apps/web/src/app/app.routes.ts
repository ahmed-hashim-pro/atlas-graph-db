import { Routes } from '@angular/router';
import { authGuard } from './core/auth.guard';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'databases' },
  { path: 'login', loadComponent: () => import('./auth/login').then((m) => m.Login) },
  { path: 'register', loadComponent: () => import('./auth/register').then((m) => m.Register) },
  {
    path: 'databases',
    canActivate: [authGuard],
    loadComponent: () => import('./shell/shell').then((m) => m.Shell),
    children: [{ path: '', loadComponent: () => import('./picker/picker').then((m) => m.Picker) }],
  },
  {
    path: 'db/:name',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./workspace/workspace-placeholder').then((m) => m.WorkspacePlaceholder),
  },
  { path: '**', redirectTo: 'databases' },
];
