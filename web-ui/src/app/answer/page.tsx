'use client';

import { Suspense, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

function AnswerRedirect() {
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    const params = new URLSearchParams(searchParams.toString());
    params.set('tab', 'answer');
    router.replace(`/research?${params.toString()}`);
  }, [router, searchParams]);

  return null;
}

/** Legacy route — executive answer lives on /research?tab=answer. */
export default function AnswerPage() {
  return (
    <Suspense fallback={null}>
      <AnswerRedirect />
    </Suspense>
  );
}
