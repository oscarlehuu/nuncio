import { useEffect, useState } from 'react';
import { fetchDigest, type DigestRunDto } from '../lib/api';
import { digestNarrative } from '../lib/home-digest-narrative';

export function HomeDigestLine() {
  const [digest, setDigest] = useState<DigestRunDto | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchDigest('latest')
      .then((result) => {
        if (!cancelled) setDigest(result);
      })
      .catch(() => {
        // Digest context is optional; Home and its attention queue stay usable offline.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!digest) return null;

  return <p className="text-ui text-muted-foreground">{digestNarrative(digest)}</p>;
}
