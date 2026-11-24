import { useCallback, useState } from "react";
import type { Collection } from "../lib/collection";
import { collectionSamples, scratchSamples, suggestedSpecFileName, type DescribedSpec, type Sample } from "../lib/describeSpec";
import type { HistoryEntry } from "../lib/history";
import type { ApiSource, LibraryEntry } from "../lib/library";
import { fileName } from "../lib/platform";
import { inTauri } from "../lib/request";
import type { ParsedSpec } from "../lib/spec";
import { downloadText, pickSpecSaveTarget, writeSpecFile } from "../lib/store";

interface Describing {
  samples: Sample[];
  /** Set when it was started from a collection, whose unlinked steps are linked afterwards. */
  collection?: { id: string; name: string };
}

/**
 * Describe as a spec (rules in `src/lib/describeSpec.ts`): which samples the
 * dialog works from, and saving its result as a file in the library.
 */
export function useDescribeSpec({
  history,
  vars,
  addWritten,
  linkToSpec,
}: {
  history: HistoryEntry[];
  vars: Record<string, string>;
  addWritten: (text: string, name: string, source: ApiSource, open: boolean) => Promise<{ entry: LibraryEntry; spec: ParsedSpec }>;
  linkToSpec: (collectionId: string, entry: LibraryEntry, spec: ParsedSpec, byKey: DescribedSpec["byTag"]) => void;
}) {
  const [describing, setDescribing] = useState<Describing | null>(null);

  const fromScratch = useCallback(() => setDescribing({ samples: scratchSamples(history) }), [history]);

  const fromCollection = useCallback(
    (collection: Collection) =>
      setDescribing({ samples: collectionSamples(collection, history, vars), collection: { id: collection.id, name: collection.name } }),
    [history, vars],
  );

  /**
   * Ask where to save, write the file, and add it to the library as a file
   * source. From the scratch screen the new spec opens; from a collection the
   * collection stays on screen with its steps linked. In the browser preview
   * the file downloads and the library keeps its text, as with a dropped file.
   */
  const save = useCallback(
    async (described: DescribedSpec, host: string): Promise<boolean> => {
      if (!describing) return false;
      const suggested = suggestedSpecFileName(host);
      let source: ApiSource;
      if (inTauri) {
        const path = await pickSpecSaveTarget(suggested);
        if (!path) return false;
        await writeSpecFile(path, described.yaml);
        source = { kind: "file", ref: path };
      } else {
        downloadText(suggested, described.yaml);
        source = { kind: "file", ref: suggested };
      }
      const { entry, spec } = await addWritten(described.yaml, fileName(source.ref), source, !describing.collection);
      if (describing.collection) linkToSpec(describing.collection.id, entry, spec, described.byTag);
      return true;
    },
    [describing, addWritten, linkToSpec],
  );

  return { describing, fromScratch, fromCollection, save, close: useCallback(() => setDescribing(null), []) };
}
