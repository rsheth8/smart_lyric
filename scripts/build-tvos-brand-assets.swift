#!/usr/bin/env swift

import AppKit
import CoreGraphics
import CoreText
import Foundation
import ImageIO
import UniformTypeIdentifiers

guard CommandLine.arguments.count == 3 else {
  fatalError("Usage: build-tvos-brand-assets.swift <background.png> <brandassets directory>")
}

let backgroundURL = URL(fileURLWithPath: CommandLine.arguments[1])
let assetRoot = URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true)
guard let source = NSImage(contentsOf: backgroundURL)?.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
  fatalError("Could not read generated background at \(backgroundURL.path)")
}

let ink = CGColor(red: 0xF6 / 255, green: 0xF0 / 255, blue: 0xE4 / 255, alpha: 1)
let gold = CGColor(red: 0xD8 / 255, green: 0xBE / 255, blue: 0x88 / 255, alpha: 1)
let ember = CGColor(red: 0xFF / 255, green: 0x71 / 255, blue: 0x5B / 255, alpha: 1)

func context(width: Int, height: Int, opaque: Bool) -> CGContext {
  let space = CGColorSpaceCreateDeviceRGB()
  let alpha: CGImageAlphaInfo = opaque ? .noneSkipLast : .premultipliedLast
  guard let result = CGContext(
    data: nil, width: width, height: height, bitsPerComponent: 8,
    bytesPerRow: 0, space: space,
    bitmapInfo: alpha.rawValue | CGBitmapInfo.byteOrder32Big.rawValue
  ) else { fatalError("Could not create \(width)x\(height) context") }
  if !opaque { result.clear(CGRect(x: 0, y: 0, width: width, height: height)) }
  return result
}

func drawAspectFill(_ image: CGImage, in rect: CGRect, context: CGContext) {
  let sourceSize = CGSize(width: image.width, height: image.height)
  let scale = max(rect.width / sourceSize.width, rect.height / sourceSize.height)
  let size = CGSize(width: sourceSize.width * scale, height: sourceSize.height * scale)
  let destination = CGRect(
    x: rect.midX - size.width / 2,
    y: rect.midY - size.height / 2,
    width: size.width,
    height: size.height
  )
  context.draw(image, in: destination)
}

func textWidth(_ text: String, font: CTFont) -> CGFloat {
  let line = CTLineCreateWithAttributedString(NSAttributedString(
    string: text,
    attributes: [.font: font]
  ))
  return CGFloat(CTLineGetTypographicBounds(line, nil, nil, nil))
}

func drawText(_ text: String, x: CGFloat, baseline: CGFloat, font: CTFont, color: CGColor, context: CGContext) {
  let line = CTLineCreateWithAttributedString(NSAttributedString(
    string: text,
    attributes: [.font: font, .foregroundColor: color]
  ))
  context.textPosition = CGPoint(x: x, y: baseline)
  CTLineDraw(line, context)
}

func write(_ image: CGImage, to url: URL) {
  try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
  guard let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else {
    fatalError("Could not create \(url.path)")
  }
  CGImageDestinationAddImage(destination, image, nil)
  guard CGImageDestinationFinalize(destination) else { fatalError("Could not write \(url.path)") }
}

func topShelf(width: Int, height: Int, output: URL) {
  let canvas = context(width: width, height: height, opaque: true)
  let bounds = CGRect(x: 0, y: 0, width: width, height: height)
  drawAspectFill(source, in: bounds, context: canvas)

  // Calm the center so the lockup survives bright display modes and motion.
  let shade = CGGradient(
    colorsSpace: CGColorSpaceCreateDeviceRGB(),
    colors: [CGColor(gray: 0, alpha: 0.72), CGColor(gray: 0, alpha: 0.10), CGColor(gray: 0, alpha: 0.48)] as CFArray,
    locations: [0, 0.52, 1]
  )!
  canvas.drawLinearGradient(shade, start: CGPoint(x: 0, y: height), end: CGPoint(x: 0, y: 0), options: [])

  let wordFont = CTFontCreateWithName("SF Pro Display Semibold" as CFString, CGFloat(height) * 0.15, nil)
  let labelFont = CTFontCreateWithName("SF Pro Display Semibold" as CFString, CGFloat(height) * 0.044, nil)
  let word = "Bar4Bar"
  let label = "THE LYRIC STAGE"
  drawText(word, x: (CGFloat(width) - textWidth(word, font: wordFont)) / 2,
           baseline: CGFloat(height) * 0.70, font: wordFont, color: ink, context: canvas)
  drawText(label, x: (CGFloat(width) - textWidth(label, font: labelFont)) / 2,
           baseline: CGFloat(height) * 0.61, font: labelFont, color: gold, context: canvas)
  write(canvas.makeImage()!, to: output)
}

func iconBack(width: Int, height: Int, output: URL) {
  let canvas = context(width: width, height: height, opaque: true)
  drawAspectFill(source, in: CGRect(x: 0, y: 0, width: width, height: height), context: canvas)
  canvas.setFillColor(CGColor(gray: 0, alpha: 0.22))
  canvas.fill(CGRect(x: 0, y: 0, width: width, height: height))
  write(canvas.makeImage()!, to: output)
}

func iconMiddle(width: Int, height: Int, output: URL) {
  let canvas = context(width: width, height: height, opaque: false)
  let unit = CGFloat(width) / 800
  let bars: [(CGFloat, CGFloat, CGFloat, CGColor)] = [
    (112, 310, 54, gold.copy(alpha: 0.42)!), (144, 270, 94, gold.copy(alpha: 0.54)!),
    (176, 226, 138, gold.copy(alpha: 0.65)!), (208, 250, 114, ember.copy(alpha: 0.58)!),
    (578, 250, 114, ember.copy(alpha: 0.58)!), (610, 226, 138, gold.copy(alpha: 0.65)!),
    (642, 270, 94, gold.copy(alpha: 0.54)!), (674, 310, 54, gold.copy(alpha: 0.42)!)
  ]
  for (x, y, barHeight, color) in bars {
    canvas.setFillColor(color)
    canvas.fill(CGRect(x: x * unit, y: y * unit, width: 14 * unit, height: barHeight * unit))
  }
  write(canvas.makeImage()!, to: output)
}

func iconFront(width: Int, height: Int, output: URL) {
  let canvas = context(width: width, height: height, opaque: false)
  let size = CGFloat(height) * 0.35
  let font = CTFontCreateWithName("SF Pro Display Semibold" as CFString, size, nil)
  let pieces: [(String, CGColor)] = [("b", ink), ("4", gold), ("b", ink)]
  let widths = pieces.map { textWidth($0.0, font: font) }
  var x = (CGFloat(width) - widths.reduce(0, +)) / 2
  let baseline = CGFloat(height) * 0.43
  for (index, piece) in pieces.enumerated() {
    drawText(piece.0, x: x, baseline: baseline, font: font, color: piece.1, context: canvas)
    x += widths[index]
  }
  canvas.setFillColor(gold.copy(alpha: 0.9)!)
  canvas.fill(CGRect(x: CGFloat(width) * 0.275, y: CGFloat(height) * 0.265,
                     width: CGFloat(width) * 0.45, height: max(3, CGFloat(height) * 0.017)))
  write(canvas.makeImage()!, to: output)
}

let regular = assetRoot.appendingPathComponent("Top Shelf Image.imageset")
let wide = assetRoot.appendingPathComponent("Top Shelf Image Wide.imageset")
let stack = assetRoot.appendingPathComponent("App Icon.imagestack")

topShelf(width: 1920, height: 720, output: regular.appendingPathComponent("shelf.png"))
topShelf(width: 3840, height: 1440, output: regular.appendingPathComponent("shelf@2x.png"))
topShelf(width: 2320, height: 720, output: wide.appendingPathComponent("shelf.png"))
topShelf(width: 4640, height: 1440, output: wide.appendingPathComponent("shelf@2x.png"))

for (scale, width, height, name) in [(1, 400, 240, "icon.png"), (2, 800, 480, "icon@2x.png")] {
  _ = scale
  iconBack(width: width, height: height, output: stack.appendingPathComponent("Back.imagestacklayer/Content.imageset/\(name)"))
  iconMiddle(width: width, height: height, output: stack.appendingPathComponent("Middle.imagestacklayer/Content.imageset/\(name)"))
  iconFront(width: width, height: height, output: stack.appendingPathComponent("Front.imagestacklayer/Content.imageset/\(name)"))
}
