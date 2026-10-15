import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="mx-auto flex max-w-xl flex-1 flex-col justify-center gap-3 p-8">
      <h1 className="text-2xl font-semibold">This page isn't here</h1>
      <p className="text-fd-muted-foreground">
        It may have moved when the guide was reorganised. The guide&apos;s start page lists everything, and the search
        box finds the rest.
      </p>
      <p>
        <Link href="/" className="text-fd-primary underline underline-offset-2">
          Go to the Spec0 Studio guide
        </Link>
      </p>
    </main>
  );
}
