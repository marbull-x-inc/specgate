/**
 * Escapes text for one cell of a GitHub-flavored Markdown table.
 *
 * @remarks
 * Backslashes are escaped first: otherwise an input `\|` becomes `\\|`, where the backslash
 * escapes the backslash and the pipe ends the cell. Line breaks become spaces because a table
 * row is one line. Inside a code span a doubled backslash is shown doubled; that is the price of
 * never letting input change the table's shape.
 */
export function markdownTableCell(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\r\n|\r|\n/g, " ");
}
