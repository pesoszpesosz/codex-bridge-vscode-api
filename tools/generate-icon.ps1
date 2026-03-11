param(
  [string]$PngPath = "media/codex-bridge.png",
  [string]$SvgPath = "media/codex-bridge.svg",
  [int]$Size = 256
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Drawing

function New-RoundedRectanglePath {
  param(
    [float]$X,
    [float]$Y,
    [float]$Width,
    [float]$Height,
    [float]$Radius
  )

  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $diameter = $Radius * 2

  $path.AddArc($X, $Y, $diameter, $diameter, 180, 90)
  $path.AddArc($X + $Width - $diameter, $Y, $diameter, $diameter, 270, 90)
  $path.AddArc($X + $Width - $diameter, $Y + $Height - $diameter, $diameter, $diameter, 0, 90)
  $path.AddArc($X, $Y + $Height - $diameter, $diameter, $diameter, 90, 90)
  $path.CloseFigure()
  return $path
}

function New-Color([string]$Hex, [int]$Alpha = 255) {
  $clean = $Hex.TrimStart("#")
  return [System.Drawing.Color]::FromArgb(
    $Alpha,
    [Convert]::ToInt32($clean.Substring(0, 2), 16),
    [Convert]::ToInt32($clean.Substring(2, 2), 16),
    [Convert]::ToInt32($clean.Substring(4, 2), 16)
  )
}

$pngFullPath = Join-Path (Get-Location) $PngPath
$svgFullPath = Join-Path (Get-Location) $SvgPath

New-Item -ItemType Directory -Force -Path (Split-Path $pngFullPath) | Out-Null
New-Item -ItemType Directory -Force -Path (Split-Path $svgFullPath) | Out-Null

$bitmap = New-Object System.Drawing.Bitmap $Size, $Size
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$graphics.Clear([System.Drawing.Color]::Transparent)

$background = New-RoundedRectanglePath 8 8 ($Size - 16) ($Size - 16) 52
$innerGlow = New-RoundedRectanglePath 20 20 ($Size - 40) ($Size - 40) 40

$gradientRect = [System.Drawing.Rectangle]::new(0, 0, $Size, $Size)
$backgroundBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  $gradientRect,
  (New-Color "#0A1524"),
  (New-Color "#113258"),
  45
)
$graphics.FillPath($backgroundBrush, $background)

$glowBrush = New-Object System.Drawing.Drawing2D.PathGradientBrush($innerGlow)
$glowBrush.CenterColor = New-Color "#1E4E7E" 90
$glowBrush.SurroundColors = @([System.Drawing.Color]::FromArgb(0, 0, 0, 0))
$graphics.FillPath($glowBrush, $innerGlow)

$borderPen = New-Object System.Drawing.Pen (New-Color "#70E7FF" 70), 2
$graphics.DrawPath($borderPen, $background)

$leftTile = New-RoundedRectanglePath 34 42 78 78 20
$rightTile = New-RoundedRectanglePath 144 42 78 78 20

$leftBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  [System.Drawing.Rectangle]::new(34, 42, 78, 78),
  (New-Color "#0E2B44" 220),
  (New-Color "#123D66" 220),
  90
)
$rightBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  [System.Drawing.Rectangle]::new(144, 42, 78, 78),
  (New-Color "#123C35" 220),
  (New-Color "#185246" 220),
  90
)
$graphics.FillPath($leftBrush, $leftTile)
$graphics.FillPath($rightBrush, $rightTile)

$tileBorderLeft = New-Object System.Drawing.Pen (New-Color "#61DAFF"), 4
$tileBorderRight = New-Object System.Drawing.Pen (New-Color "#67F6C5"), 4
$graphics.DrawPath($tileBorderLeft, $leftTile)
$graphics.DrawPath($tileBorderRight, $rightTile)

$codePen = New-Object System.Drawing.Pen (New-Color "#B8F7FF"), 8
$codePen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$codePen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$graphics.DrawLines($codePen, @(
  [System.Drawing.Point]::new(79, 62),
  [System.Drawing.Point]::new(57, 80),
  [System.Drawing.Point]::new(79, 98)
))
$graphics.DrawLines($codePen, @(
  [System.Drawing.Point]::new(94, 62),
  [System.Drawing.Point]::new(116, 80),
  [System.Drawing.Point]::new(94, 98)
))

$sparkPen = New-Object System.Drawing.Pen (New-Color "#D8FFF1"), 7
$sparkPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$sparkPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$graphics.DrawLine($sparkPen, 183, 58, 183, 104)
$graphics.DrawLine($sparkPen, 160, 81, 206, 81)
$graphics.DrawLine($sparkPen, 168, 66, 198, 96)
$graphics.DrawLine($sparkPen, 198, 66, 168, 96)

$bridgePen = New-Object System.Drawing.Pen (New-Color "#F6FBFF"), 12
$bridgePen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$bridgePen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$graphics.DrawBezier(
  $bridgePen,
  [System.Drawing.Point]::new(52, 176),
  [System.Drawing.Point]::new(86, 132),
  [System.Drawing.Point]::new(170, 132),
  [System.Drawing.Point]::new(204, 176)
)

$deckPen = New-Object System.Drawing.Pen (New-Color "#9EE8FF"), 10
$deckPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$deckPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$graphics.DrawLine($deckPen, 62, 176, 194, 176)

$pillarPen = New-Object System.Drawing.Pen (New-Color "#A9F6DE"), 6
$pillarPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$pillarPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$graphics.DrawLine($pillarPen, 84, 156, 84, 176)
$graphics.DrawLine($pillarPen, 114, 146, 114, 176)
$graphics.DrawLine($pillarPen, 142, 146, 142, 176)
$graphics.DrawLine($pillarPen, 172, 156, 172, 176)

$nodeBrush = New-Object System.Drawing.SolidBrush (New-Color "#67F6C5")
$graphics.FillEllipse($nodeBrush, 118, 165, 20, 20)

$shadowBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(40, 0, 0, 0))
$graphics.FillEllipse($shadowBrush, 48, 186, 160, 18)

$bitmap.Save($pngFullPath, [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bitmap.Dispose()

$svg = @"
<svg xmlns="http://www.w3.org/2000/svg" width="$Size" height="$Size" viewBox="0 0 256 256">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0A1524"/>
      <stop offset="100%" stop-color="#113258"/>
    </linearGradient>
    <linearGradient id="leftTile" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#0E2B44" stop-opacity="0.86"/>
      <stop offset="100%" stop-color="#123D66" stop-opacity="0.86"/>
    </linearGradient>
    <linearGradient id="rightTile" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#123C35" stop-opacity="0.86"/>
      <stop offset="100%" stop-color="#185246" stop-opacity="0.86"/>
    </linearGradient>
  </defs>
  <rect x="8" y="8" width="240" height="240" rx="52" fill="url(#bg)"/>
  <rect x="8" y="8" width="240" height="240" rx="52" fill="none" stroke="#70E7FF" stroke-opacity="0.28" stroke-width="2"/>
  <rect x="34" y="42" width="78" height="78" rx="20" fill="url(#leftTile)" stroke="#61DAFF" stroke-width="4"/>
  <rect x="144" y="42" width="78" height="78" rx="20" fill="url(#rightTile)" stroke="#67F6C5" stroke-width="4"/>
  <polyline points="79,62 57,80 79,98" fill="none" stroke="#B8F7FF" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>
  <polyline points="94,62 116,80 94,98" fill="none" stroke="#B8F7FF" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>
  <line x1="183" y1="58" x2="183" y2="104" stroke="#D8FFF1" stroke-width="7" stroke-linecap="round"/>
  <line x1="160" y1="81" x2="206" y2="81" stroke="#D8FFF1" stroke-width="7" stroke-linecap="round"/>
  <line x1="168" y1="66" x2="198" y2="96" stroke="#D8FFF1" stroke-width="7" stroke-linecap="round"/>
  <line x1="198" y1="66" x2="168" y2="96" stroke="#D8FFF1" stroke-width="7" stroke-linecap="round"/>
  <path d="M52 176 C86 132 170 132 204 176" fill="none" stroke="#F6FBFF" stroke-width="12" stroke-linecap="round"/>
  <line x1="62" y1="176" x2="194" y2="176" stroke="#9EE8FF" stroke-width="10" stroke-linecap="round"/>
  <line x1="84" y1="156" x2="84" y2="176" stroke="#A9F6DE" stroke-width="6" stroke-linecap="round"/>
  <line x1="114" y1="146" x2="114" y2="176" stroke="#A9F6DE" stroke-width="6" stroke-linecap="round"/>
  <line x1="142" y1="146" x2="142" y2="176" stroke="#A9F6DE" stroke-width="6" stroke-linecap="round"/>
  <line x1="172" y1="156" x2="172" y2="176" stroke="#A9F6DE" stroke-width="6" stroke-linecap="round"/>
  <circle cx="128" cy="175" r="10" fill="#67F6C5"/>
</svg>
"@

Set-Content -Path $svgFullPath -Value $svg -Encoding utf8
Write-Output "Generated $PngPath and $SvgPath"
