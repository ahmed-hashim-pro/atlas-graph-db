import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'login' },
  { path: 'login', loadComponent: () => import('./auth/login').then((m) => m.Login) },
  { path: 'register', loadComponent: () => import('./auth/register').then((m) => m.Register) },
  { path: '**', redirectTo: 'login' },
];
