import SwiftUI

/// Wrapping horizontal layout for lyric words.
///
/// An `HStack` cannot wrap, and a lyric line at hero size routinely overruns
/// 1920pt — without this, long lines either clip or get squeezed to an
/// unreadable scale. Words stay individually addressable views (each needs its
/// own wipe), so a single `Text` with attributed runs is not an option.
struct FlowLayout: Layout {
  var spacing: CGFloat = 16
  var lineSpacing: CGFloat = 10
  var alignment: HorizontalAlignment = .center

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    let maxWidth = proposal.width ?? .infinity
    let rows = layoutRows(subviews: subviews, maxWidth: maxWidth)
    let height = rows.reduce(0) { $0 + $1.height } + lineSpacing * CGFloat(max(0, rows.count - 1))
    let width = rows.map(\.width).max() ?? 0
    return CGSize(width: min(width, maxWidth), height: height)
  }

  func placeSubviews(
    in bounds: CGRect,
    proposal: ProposedViewSize,
    subviews: Subviews,
    cache: inout ()
  ) {
    let rows = layoutRows(subviews: subviews, maxWidth: bounds.width)
    var y = bounds.minY

    for row in rows {
      var x: CGFloat
      switch alignment {
      case .leading: x = bounds.minX
      case .trailing: x = bounds.maxX - row.width
      default: x = bounds.minX + (bounds.width - row.width) / 2
      }

      for item in row.items {
        let size = subviews[item].sizeThatFits(.unspecified)
        subviews[item].place(
          at: CGPoint(x: x, y: y + (row.height - size.height) / 2),
          proposal: ProposedViewSize(size)
        )
        x += size.width + spacing
      }
      y += row.height + lineSpacing
    }
  }

  private struct Row {
    var items: [Int] = []
    var width: CGFloat = 0
    var height: CGFloat = 0
  }

  private func layoutRows(subviews: Subviews, maxWidth: CGFloat) -> [Row] {
    var rows: [Row] = []
    var row = Row()

    for index in subviews.indices {
      let size = subviews[index].sizeThatFits(.unspecified)
      let additional = row.items.isEmpty ? size.width : row.width + spacing + size.width

      if !row.items.isEmpty, additional > maxWidth {
        rows.append(row)
        row = Row()
        row.items = [index]
        row.width = size.width
        row.height = size.height
      } else {
        row.items.append(index)
        row.width = additional
        row.height = max(row.height, size.height)
      }
    }
    if !row.items.isEmpty { rows.append(row) }
    return rows
  }
}
