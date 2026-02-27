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
