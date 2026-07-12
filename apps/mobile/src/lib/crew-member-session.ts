import type { Session } from '@nuncio/core/api';

export function crewMemberSessionAccess(session: Pick<Session, 'verifyOwner'> | null) {
  const managedByCrew = session?.verifyOwner === 'crew';
  return { managedByCrew, canMutate: !managedByCrew };
}
