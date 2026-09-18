#!/usr/bin/env swift
import Foundation
import CoreText
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

// Original native typography only. Run from the repository root.
let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
let assets = root.appendingPathComponent("tvos/Bar4BarTV/Assets.xcassets/App Icon & Top Shelf Image.brandassets")
CTFontManagerRegisterFontsForURL(root.appendingPathComponent("tvos/Bar4BarTV/Fonts/Fraunces.ttf") as CFURL, .process, nil)
func color(_ hex: UInt32, _ alpha: CGFloat = 1) -> CGColor {
  CGColor(red: CGFloat((hex >> 16) & 255)/255, green: CGFloat((hex >> 8) & 255)/255, blue: CGFloat(hex & 255)/255, alpha: alpha)
}
func font(_ size: CGFloat) -> CTFont {
  let d = CTFontDescriptorCreateWithAttributes([kCTFontNameAttribute: "Fraunces-9ptBlack", kCTFontVariationAttribute: [NSNumber(value:0x77676874):650,NSNumber(value:0x6F70737A):96]] as CFDictionary)
  return CTFontCreateWithFontDescriptor(d, size, nil)
}
func text(_ value: String, _ x: CGFloat, _ y: CGFloat, _ size: CGFloat, _ ink: CGColor, _ c: CGContext) {
 let line = CTLineCreateWithAttributedString(NSAttributedString(string:value, attributes:[NSAttributedString.Key(kCTFontAttributeName as String):font(size),NSAttributedString.Key(kCTForegroundColorAttributeName as String):ink]))
 c.textPosition = CGPoint(x:x,y:y);CTLineDraw(line,c)
}
func render(_ width: Int, _ height: Int, layer: Int, output: String, shelf: Bool = false) {
 let c = CGContext(data:nil,width:width,height:height,bitsPerComponent:8,bytesPerRow:0,space:CGColorSpaceCreateDeviceRGB(),bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue)!
 let w=CGFloat(width), h=CGFloat(height)
 if layer==0 {
  c.setFillColor(color(0x19121F));c.fill(CGRect(x:0,y:0,width:w,height:h))
  for d in (0...3).reversed(){text("B4",w*0.48+CGFloat(d)*h*0.015,-h*0.12+CGFloat(d)*h*0.025,h*1.3,color(d==0 ? 0xEF684B:0xB9A1DC, d==0 ? 0.22:0.07),c)}
 }
 if layer==1 {text("4",w*0.62,-h*0.22,h*1.35,color(0xB9A1DC,0.12),c)}
 if layer==2 || shelf {
  let label=shelf ? "Bar4Bar":"B4B"
  let size=h*(shelf ? 0.28:0.43)
  text(label,w*(shelf ? 0.08:0.14),h*(shelf ? 0.52:0.34),size,color(0xF2EBDD),c)
  if shelf {text("Your voice, in good company.",w*0.08,h*0.27,h*0.095,color(0xB9A1DC),c)}
 }
 let url=assets.appendingPathComponent(output)
 let dest=CGImageDestinationCreateWithURL(url as CFURL,UTType.png.identifier as CFString,1,nil)!
 CGImageDestinationAddImage(dest,c.makeImage()!,nil);precondition(CGImageDestinationFinalize(dest))
}
for (w,h,name) in [(400,240,"icon.png"),(800,480,"icon@2x.png")] {
 for (i,layer) in ["Back","Middle","Front"].enumerated() {
  render(w,h,layer:i,output:"App Icon.imagestack/\(layer).imagestacklayer/Content.imageset/\(name)")
 }
}
for (w,h,folder,name) in [(1920,720,"Top Shelf Image","shelf.png"),(3840,1440,"Top Shelf Image","shelf@2x.png"),(2320,720,"Top Shelf Image Wide","shelf.png"),(4640,1440,"Top Shelf Image Wide","shelf@2x.png")] {
 render(w,h,layer:0,output:"\(folder).imageset/\(name)",shelf:true)
}
