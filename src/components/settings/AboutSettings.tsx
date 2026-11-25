import { useEffect, useMemo, useState } from "react";
import { ChevronRight, ExternalLink } from "lucide-react";
import { RELEASES_PAGE } from "../../lib/appUpdates";
import { filterPackages, licenceCounts, loadLicences, type LicencedPackage } from "../../lib/licences";
import { inTauri } from "../../lib/request";
import { openInBrowser } from "../../lib/store";

const SOURCE = "https://github.com/spec-0/studio";

/** About: which Studio this is, and the open-source packages it's built with. */
export function AboutSettings({ version }: { version?: string | null }) {
  const [packages, setPackages] = useState<LicencedPackage[] | null | undefined>(null);
  const [query, setQuery] = useState("");
  useEffect(() => {
    let live = true;
    void loadLicences().then((list) => live && setPackages(list));
    return () => {
      live = false;
    };
  }, []);
  const shown = useMemo(() => (packages ? filterPackages(packages, query) : []), [packages, query]);
  const counts = useMemo(() => (packages ? licenceCounts(packages) : []), [packages]);

  return (
    <>
      <div className="rows">
        <div className="row-s">
          <div className="l">
            <b>
              spec0 Studio <span className="mono">{version ?? (inTauri ? "" : "browser preview")}</span>
            </b>
            <span className="meta">Open source under the MIT licence.</span>
          </div>
          <div className="c">
            <button className="btn ghost" onClick={() => void openInBrowser(RELEASES_PAGE)}>
              Release notes <ExternalLink size={12} />
            </button>
            <button className="btn ghost" onClick={() => void openInBrowser(SOURCE)}>
              Source code <ExternalLink size={12} />
            </button>
          </div>
        </div>
      </div>

      <div className="section-head licences-head">
        <div className="l">
          <h2 className="h2">Open-source licences</h2>
          <span className="meta">
            {packages
              ? `Studio is built with ${packages.length} open-source packages: ${counts
                  .map(([licence, n]) => `${n} ${licence}`)
                  .join(", ")}. Open one to read its licence and notice.`
              : "The open-source packages Studio is built with, and their licences."}
          </span>
        </div>
      </div>

      {packages === null ? (
        <p className="meta">Loading…</p>
      ) : packages === undefined ? (
        <p className="meta">The list is written when Studio is built, so a development build doesn&apos;t have one.</p>
      ) : (
        <>
          <div className="licences-bar">
            <input
              className="input"
              type="search"
              placeholder="Filter by package or licence"
              aria-label="Filter packages"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <div className="rows licences">
            {shown.length === 0 && <div className="row-s meta">No package matches “{query.trim()}”.</div>}
            {shown.map((p) => (
              <details key={`${p.name}@${p.version}`} className="licence">
                <summary>
                  <ChevronRight size={13} className="licence-chevron" aria-hidden />
                  <span className="mono licence-name">{p.name}</span>
                  <span className="meta mono">{p.version}</span>
                  <span className="chip sans">{p.license}</span>
                </summary>
                <div className="licence-body">
                  {p.homepage && (
                    <button className="btn ghost tight" onClick={() => void openInBrowser(p.homepage!)}>
                      Source <ExternalLink size={12} />
                    </button>
                  )}
                  <pre className="code">
                    {p.texts.length
                      ? p.texts.join("\n\n")
                      : `This package ships no licence file. It is distributed under ${p.license}.`}
                  </pre>
                </div>
              </details>
            ))}
          </div>
        </>
      )}
    </>
  );
}
