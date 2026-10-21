import { redirect } from 'next/navigation';

/** Connections now live in Settings. This address keeps old links working. */
export default function ConnectionsRedirect() {
  redirect('/settings/connections');
}
