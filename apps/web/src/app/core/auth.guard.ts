import { inject } from '@angular/core';
import {
  ActivatedRouteSnapshot,
  CanActivateFn,
  Router,
  RouterStateSnapshot,
  UrlTree,
} from '@angular/router';
import { AuthService } from './auth.service';

/** Allows the route when a session exists; otherwise redirects to /login. */
export const authGuard = (async (
  _route?: ActivatedRouteSnapshot,
  _state?: RouterStateSnapshot,
): Promise<boolean | UrlTree> => {
  const auth = inject(AuthService);
  const router = inject(Router);
  if (auth.isAuthenticated()) return true;
  const user = await auth.refresh();
  return user !== null ? true : router.parseUrl('/login');
}) satisfies CanActivateFn;
