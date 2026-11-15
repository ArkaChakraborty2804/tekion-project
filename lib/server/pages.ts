/** Server-side checks for the customer pages (server components only). */
import { runtime } from './runtime.ts';

/** Customer pages render only on a loopback bind (capability links are not reviewed customer auth). */
export function customerPagesEnabled(): boolean {
  try {
    return runtime().customerPagesEnabled;
  } catch {
    return false;
  }
}
