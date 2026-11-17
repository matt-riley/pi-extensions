// tsv.mjs — one row of an append-only TSV log. Shared because /until, /climb and
// the decision trail all write the same kind of log under .pi/runs/.

/** One TSV row; cells are single-line and spreadsheet-formula safe. */
export function tsvRow(cells) {
  return (
    cells
      .map((c) => {
        const s = String(c ?? "").replace(/[\t\r\n]+/g, " ");
        return /^[=+\-@]/.test(s) ? `'${s}` : s;
      })
      .join("\t") + "\n"
  );
}
