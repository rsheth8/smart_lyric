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
  var balanced: Bool = false

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    let maxWidth = proposal.width ?? .infinity
    let rows = layoutRows(subviews: subviews, maxWidth: maxWidth)
    let height = rows.reduce(0) { $0 + $1.height } + lineSpacing * CGFloat(max(0, rows.count - 1))
    let width = rows.map(\.width).max() ?? 0
    return CGSize(width: balanced && maxWidth.isFinite ? maxWidth : min(width, maxWidth), height: height)
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
        let size = measure(subviews[item], maxWidth: bounds.width)
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
      let size = measure(subviews[index], maxWidth: maxWidth)
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
    if balanced, rows.count > 1 {
      // Move trailing words onto the next row only when that improves balance.
      // This keeps a held final word from sitting alone below a nearly full row.
      let sizes = subviews.map { measure($0, maxWidth: maxWidth) }
      for index in stride(from: rows.count - 2, through: 0, by: -1) {
        while rows[index].items.count > 1, let last = rows[index].items.last {
          let removed = sizes[last].width + spacing
          let newLeft = rows[index].width - removed
          let newRight = rows[index + 1].width + removed
          let removesOrphan = rows[index + 1].items.count == 1 && rows[index].items.count > 2
          guard newRight <= maxWidth,
                removesOrphan || abs(newLeft - newRight) < abs(rows[index].width - rows[index + 1].width) else { break }
          rows[index].items.removeLast()
          rows[index + 1].items.insert(last, at: 0)
          rows[index].width = newLeft
          rows[index + 1].width = newRight
          rows[index].height = rows[index].items.map { sizes[$0].height }.max() ?? 0
          rows[index + 1].height = rows[index + 1].items.map { sizes[$0].height }.max() ?? 0
        }
      }
    }
    return rows
  }

  /// Propose the full line width, not the leftover on this row. A word that
  /// still fits on the next row should wrap — shrinking mid-line looks uneven.
  /// Only a single token wider than the stage is asked to squeeze.
  private func measure(_ view: LayoutSubview, maxWidth: CGFloat) -> CGSize {
    let proposal: ProposedViewSize =
      maxWidth.isFinite && maxWidth > 0
      ? ProposedViewSize(width: maxWidth, height: nil)
      : .unspecified
    var size = view.sizeThatFits(proposal)
    if maxWidth.isFinite, size.width > maxWidth {
      size.width = maxWidth
    }
    return size
  }
}
