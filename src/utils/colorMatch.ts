/**
 * Implements a statistical color transfer algorithm (similar to Reinhard et al. color transfer)
 * but optimized for RGB space for browser performance.
 * It forces the target image to match the mean and standard deviation of the reference image's color channels.
 */

// Helper to load an image from Base64
function loadImage(src: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onerror = reject;
        img.onload = () => resolve(img);
        img.src = src.startsWith('data:') ? src : `data:image/png;base64,${src}`;
    });
}

// Get raw ImageData from an Image object
function getImageData(img: HTMLImageElement): ImageData {
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    return ctx.getImageData(0, 0, img.width, img.height);
}

interface ChannelStats {
    mean: number;
    std: number;
}

// Calculate mean and standard deviation for a specific color channel
function getChannelStats(data: Uint8ClampedArray, offset: number): ChannelStats {
    let sum = 0;
    const count = data.length / 4;
    for (let i = offset; i < data.length; i += 4) {
        sum += data[i];
    }
    const mean = sum / count;

    let varianceSum = 0;
    for (let i = offset; i < data.length; i += 4) {
        const diff = data[i] - mean;
        varianceSum += diff * diff;
    }
    const std = Math.sqrt(varianceSum / count);

    return { mean, std: std === 0 ? 1 : std }; // Prevent division by zero
}

/**
 * Applies the color statistics of the reference image onto the source image.
 * Returns a base64 encoded string of the modified source image.
 */
export async function applyColorMatch(sourceB64: string, refB64: string): Promise<string> {
    const [sourceImg, refImg] = await Promise.all([
        loadImage(sourceB64),
        loadImage(refB64)
    ]);

    const srcData = getImageData(sourceImg);
    const refData = getImageData(refImg);

    // Get statistics for RGB channels
    const srcStatsR = getChannelStats(srcData.data, 0);
    const srcStatsG = getChannelStats(srcData.data, 1);
    const srcStatsB = getChannelStats(srcData.data, 2);

    const refStatsR = getChannelStats(refData.data, 0);
    const refStatsG = getChannelStats(refData.data, 1);
    const refStatsB = getChannelStats(refData.data, 2);

    // Apply transformation
    const outData = new Uint8ClampedArray(srcData.data.length);

    for (let i = 0; i < srcData.data.length; i += 4) {
        // R
        let r = ((srcData.data[i] - srcStatsR.mean) * (refStatsR.std / srcStatsR.std)) + refStatsR.mean;
        outData[i] = Math.min(255, Math.max(0, r));

        // G
        let g = ((srcData.data[i + 1] - srcStatsG.mean) * (refStatsG.std / srcStatsG.std)) + refStatsG.mean;
        outData[i + 1] = Math.min(255, Math.max(0, g));

        // B
        let b = ((srcData.data[i + 2] - srcStatsB.mean) * (refStatsB.std / srcStatsB.std)) + refStatsB.mean;
        outData[i + 2] = Math.min(255, Math.max(0, b));

        // A (preserve alpha)
        outData[i + 3] = srcData.data[i + 3];

        // Apply a subtle Luminance blend to prevent over-saturation (Optional but good for realism)
        // A direct RGB match can sometimes cause heavy banding in shadows/highlights.
        // We do a 85% match strength to keep it natural.
        const strength = 0.85;
        outData[i] = (outData[i] * strength) + (srcData.data[i] * (1 - strength));
        outData[i + 1] = (outData[i + 1] * strength) + (srcData.data[i + 1] * (1 - strength));
        outData[i + 2] = (outData[i + 2] * strength) + (srcData.data[i + 2] * (1 - strength));
    }

    // Put data back to a new canvas and export
    const canvas = document.createElement('canvas');
    canvas.width = sourceImg.width;
    canvas.height = sourceImg.height;
    const ctx = canvas.getContext('2d')!;
    const newImgData = new ImageData(outData, sourceImg.width, sourceImg.height);
    ctx.putImageData(newImgData, 0, 0);

    return canvas.toDataURL('image/png');
}

export interface ColorAdjustments {
    exposure: number;    // -150 to 150
    contrast: number;    // -50 to 100
    temperature: number; // -100 to 100 (Blue vs Yellow)
    tint: number;        // -100 to 100 (Green vs Magenta)
    saturation: number;  // -100 to 100
    lightness: number;   // -100 to 100
}

/**
 * Mathematically extracts the required color adjustment sliders to match the reference image.
 * This simulates a smart color transfer without destructively baking pixels.
 */
export async function extractColorAdjustments(sourceB64: string, refB64: string): Promise<ColorAdjustments> {
    const [sourceImg, refImg] = await Promise.all([
        loadImage(sourceB64),
        loadImage(refB64)
    ]);

    const srcData = getImageData(sourceImg);
    const refData = getImageData(refImg);

    const srcStatsR = getChannelStats(srcData.data, 0);
    const srcStatsG = getChannelStats(srcData.data, 1);
    const srcStatsB = getChannelStats(srcData.data, 2);

    const refStatsR = getChannelStats(refData.data, 0);
    const refStatsG = getChannelStats(refData.data, 1);
    const refStatsB = getChannelStats(refData.data, 2);

    // Luminance approx: Y = 0.299R + 0.587G + 0.114B
    const srcLumMean = 0.299 * srcStatsR.mean + 0.587 * srcStatsG.mean + 0.114 * srcStatsB.mean;
    const refLumMean = 0.299 * refStatsR.mean + 0.587 * refStatsG.mean + 0.114 * refStatsB.mean;

    const srcLumStd = (srcStatsR.std + srcStatsG.std + srcStatsB.std) / 3;
    const refLumStd = (refStatsR.std + refStatsG.std + refStatsB.std) / 3;

    let exposure = ((refLumMean - srcLumMean) / 255) * 150;
    let contrast = ((refLumStd - srcLumStd) / 128) * 100;

    const srcTemp = (srcStatsR.mean + srcStatsG.mean) / 2 - srcStatsB.mean;
    const refTemp = (refStatsR.mean + refStatsG.mean) / 2 - refStatsB.mean;
    let temperature = ((refTemp - srcTemp) / 255) * 100 * 2.5; // Multiplier for stronger effect

    const srcTint = (srcStatsR.mean + srcStatsB.mean) / 2 - srcStatsG.mean;
    const refTint = (refStatsR.mean + refStatsB.mean) / 2 - refStatsG.mean;
    let tint = ((refTint - srcTint) / 255) * 100 * 2.5;

    let lightness = exposure > 0 ? exposure * 0.4 : exposure * 0.4;

    const srcColorSpread = Math.abs(srcStatsR.mean - srcLumMean) + Math.abs(srcStatsG.mean - srcLumMean) + Math.abs(srcStatsB.mean - srcLumMean);
    const refColorSpread = Math.abs(refStatsR.mean - refLumMean) + Math.abs(refStatsG.mean - refLumMean) + Math.abs(refStatsB.mean - refLumMean);
    let saturation = ((refColorSpread - srcColorSpread) / 255) * 100 * 3.0;

    const clamp = (val: number, min: number, max: number) => Math.min(Math.max(val, min), max);

    return {
        exposure: Math.round(clamp(exposure, -150, 150)),
        contrast: Math.round(clamp(contrast, -50, 100)),
        temperature: Math.round(clamp(temperature, -100, 100)),
        tint: Math.round(clamp(tint, -100, 100)),
        saturation: Math.round(clamp(saturation, -100, 100)),
        lightness: Math.round(clamp(lightness, -100, 100))
    };
}
