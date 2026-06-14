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
    children: [
      { path: '', loadComponent: () => import('./picker/picker').then((m) => m.Picker) },
      { path: 'import', loadComponent: () => import('./import/import').then((m) => m.Import) },
      { path: 'admin', loadComponent: () => import('./admin/admin').then((m) => m.Admin) },
    ],
  },
  {
    path: 'db/:name',
    canActivate: [authGuard],
    loadComponent: () => import('./workspace/workspace').then((m) => m.Workspace),
  },
  {
    path: 'db/:name/schema',
    canActivate: [authGuard],
    loadComponent: () => import('./workspace/schema-view').then((m) => m.SchemaView),
  },
  {
    path: 'db/:name/algorithms',
    canActivate: [authGuard],
    loadComponent: () => import('./workspace/algorithms-view').then((m) => m.AlgorithmsView),
  },
  { path: '**', redirectTo: 'databases' },
];
