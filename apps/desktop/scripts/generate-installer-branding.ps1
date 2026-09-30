<# Render installer branding from the product icon and system text fonts. #>
[CmdletBinding()]
param([string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $PSScriptRoot '../installer/assets' }
$output = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $output | Out-Null
Add-Type -AssemblyName System.Drawing
$icon = [Drawing.Image]::FromFile([IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../icons/icon.png')))
try {
    foreach ($asset in @('brand', 'brand-2x', 'brand-dark', 'brand-dark-2x', 'uninstaller-sidebar')) {
        $scale = if ($asset.EndsWith('-2x')) { 2 } else { 1 }
        $sidebar = $asset -eq 'uninstaller-sidebar'
        $width = if ($sidebar) { 164 } else { 600 * $scale }
        $height = if ($sidebar) { 314 } else { 196 * $scale }
        $bitmap = [Drawing.Bitmap]::new($width, $height)
        $graphics = [Drawing.Graphics]::FromImage($bitmap)
        $font = $null
        $brush = $null
        $format = $null
        try {
            $dark = $asset -like '*dark*'
            $graphics.Clear($(if ($dark) { [Drawing.Color]::FromArgb(21, 21, 23) } else { [Drawing.Color]::White }))
            $graphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
            $graphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $graphics.TextRenderingHint = [Drawing.Text.TextRenderingHint]::AntiAliasGridFit
            $edge = if ($sidebar) { 100 } else { 110 * $scale }
            $x = [int](($width - $edge) / 2)
            $y = if ($sidebar) { 54 } else { 6 * $scale }
            $graphics.DrawImage($icon, $x, $y, $edge, $edge)
            $size = if ($sidebar) { 15 } else { 30 * $scale }
            $font = [Drawing.Font]::new('Segoe UI', $size, [Drawing.FontStyle]::Bold, [Drawing.GraphicsUnit]::Pixel)
            $brush = [Drawing.SolidBrush]::new($(if ($dark) { [Drawing.Color]::White } else { [Drawing.Color]::FromArgb(25, 42, 58) }))
            $format = [Drawing.StringFormat]::new()
            $format.Alignment = [Drawing.StringAlignment]::Center
            $format.LineAlignment = [Drawing.StringAlignment]::Center
            $labelY = if ($sidebar) { 165 } else { 132 * $scale }
            $rectangle = [Drawing.RectangleF]::new(0, $labelY, $width, $(if ($sidebar) { 58 } else { 48 * $scale }))
            $graphics.DrawString('SciPaper Harness', $font, $brush, $rectangle, $format)
            $bitmap.Save((Join-Path $output "$asset.png"), [Drawing.Imaging.ImageFormat]::Png)
        } finally {
            if ($format) { $format.Dispose() }
            if ($brush) { $brush.Dispose() }
            if ($font) { $font.Dispose() }
            $graphics.Dispose()
            $bitmap.Dispose()
        }
    }
} finally { $icon.Dispose() }
