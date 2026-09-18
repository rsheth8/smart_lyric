import Foundation
import CoreText
import CoreGraphics
let root = FileManager.default.currentDirectoryPath
CTFontManagerRegisterFontsForURL(URL(fileURLWithPath: root + "/tvos/Bar4BarTV/Fonts/Fraunces.ttf") as CFURL, .process, nil)
CTFontManagerRegisterFontsForURL(URL(fileURLWithPath: root + "/tvos/Bar4BarTV/Fonts/Manrope.ttf") as CFURL, .process, nil)
func outline(_ text: String, size: CGFloat, display: Bool = true) -> String {
 let name = display ? "Fraunces-9ptBlack" : "Manrope-ExtraLight"
 let desc = CTFontDescriptorCreateWithAttributes([kCTFontNameAttribute:name,kCTFontVariationAttribute:[NSNumber(value:0x77676874):NSNumber(value:display ? 650 : 600)]] as CFDictionary)
 let font = CTFontCreateWithFontDescriptor(desc,size,nil)
 let line = CTLineCreateWithAttributedString(NSAttributedString(string:text,attributes:[NSAttributedString.Key(kCTFontAttributeName as String):font]))
 let path = CGMutablePath()
 for run in CTLineGetGlyphRuns(line) as! [CTRun] {
  let n=CTRunGetGlyphCount(run);var glyphs=[CGGlyph](repeating:0,count:n);var positions=[CGPoint](repeating:.zero,count:n)
  CTRunGetGlyphs(run,CFRange(location:0,length:0),&glyphs);CTRunGetPositions(run,CFRange(location:0,length:0),&positions)
  let face=(CTRunGetAttributes(run) as NSDictionary)[kCTFontAttributeName] as! CTFont
  for i in 0..<n { if let p=CTFontCreatePathForGlyph(face,glyphs[i],nil){path.addPath(p,transform:CGAffineTransform(a:1,b:0,c:0,d:-1,tx:positions[i].x,ty:0))} }
 }
 var result=""
 path.applyWithBlock { ptr in let e=ptr.pointee;let p=e.points
 func point(_ i:Int)->String { "\(p[i].x),\(p[i].y)" }
 switch e.type {case .moveToPoint:result += "M\(point(0))";case .addLineToPoint:result += "L\(point(0))";case .addQuadCurveToPoint:result += "Q\(point(0)) \(point(1))";case .addCurveToPoint:result += "C\(point(0)) \(point(1)) \(point(2))";case .closeSubpath:result += "Z";@unknown default:break}
 }
 return result
}
func type(_ text:String,_ x:Int,_ y:Int,_ size:Int,_ color:String="ivory",_ display:Bool=true)->String{
 let colors=["ivory":"#F2EBDD","coral":"#EF684B","lilac":"#B9A1DC","lime":"#D8E77B"]
 return "<path transform='translate(\(x) \(y))' fill='\(colors[color]!)' d='\(outline(text,size:CGFloat(size),display:display))'/>"
}
let names=["01 / HOME","02 / SONG SELECTION","03 / STAGE STUDIES","04 / VERSE","05 / HOOK","06 / HANDOFF"]
var svg="<svg xmlns='http://www.w3.org/2000/svg' width='1920' height='1340' viewBox='0 0 1920 1340'><rect width='1920' height='1340' fill='#100F15'/>"
for i in 0..<6 {
 let x=30+(i%2)*945;let y=30+(i/2)*435
 svg += "<g transform='translate(\(x) \(y))'><defs><clipPath id='c\(i)'><rect width='915' height='390'/></clipPath></defs><g clip-path='url(#c\(i))'><rect width='915' height='390' fill='#19121F'/><g opacity='.30' transform='rotate(-12 650 60)'>"
 for d in (1...3).reversed(){svg += "<g opacity='.25'>"+type(i==0 ? "Bar4Bar":"B4",400+d*8,180+d*9,280,"lilac")+"</g>"}
 svg += type(i==0 ? "Bar4Bar":"B4",400,180,280,i==4 ? "lime":"coral")+"</g>"
 svg += "<rect x='38' y='165' width='805' height='185' fill='#19121F' opacity='.90'/>"
 switch i {
 case 0:svg += type("Your voice,",45,170,52)+type("in good company.",45,230,52)+type("Find a song    /    Enter the stage",45,320,23,"ivory",false)
 case 1:svg += type("Find a song",45,100,52)+type("01",45,220,38,"coral")+type("Drop the needle",130,220,34)+type("Bar4Bar / Approximate word guidance",130,258,17,"lilac",false)+type("02    Bring the room",45,329,30)
 case 2:svg += type("Choose your atmosphere.",45,102,44)+type("Make this moment yours.",45,224,40,"ivory",false)+type("I   Focus       II   Live       III   Headliner",45,320,24,"lilac",false)
 case 3:svg += type("YOUR STAGE / VERSE",45,112,18,"lilac",false)+type("Drop the needle,",45,203,48,"ivory",false)+type("let the room turn gold",45,265,48,"ivory",false)+type("UP NEXT / Every bar lands right",45,343,21,"coral",false)
 case 4:svg += type("EVERYONE / THE HOOK",45,112,18,"lime",false)+type("Say it with me,",45,203,48,"ivory",false)+type("syllable for syllable",45,265,48,"ivory",false)+"<path d='M45 280H220' stroke='#D8E77B' stroke-width='4'/>"+type("UP NEXT / Nothing rushed",45,343,21,"lilac",false)
 default:svg += type("SIDE A / YOUR TURN",45,112,18,"coral",false)+type("Hold it here",45,230,54,"ivory",false)+type("Next: Side B",45,310,32,"lilac")+type("And I’ll take the harmony",45,353,22,"ivory",false)
 }
 svg += "</g>"+type(names[i],5,416,16,"ivory",false)+"</g>"
}
svg += "</svg>"
try svg.write(toFile:root+"/docs/brand/studies/installation-studies.svg",atomically:true,encoding:.utf8)
