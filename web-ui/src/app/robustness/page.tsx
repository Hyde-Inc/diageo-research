'use client';

import { Suspense, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

function RobustnessRedirect() {
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    const params = new URLSearchParams(searchParams.toString());
    params.set('tab', 'robustness');
    router.replace(`/research?${params.toString()}`);
  }, [router, searchParams]);

  return null;
}

/** Legacy route — robustness lives on /research?tab=robustness. */
export default function RobustnessPage() {
  return (
    <Suspense fallback={null}>
      <RobustnessRedirect />
    </Suspense>
  );
}
