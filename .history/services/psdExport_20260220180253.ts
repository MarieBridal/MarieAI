import { writePsd } from 'ag-psd';
import { TextNode } from './gemini';

export interface PsdLayerParams {
    name: string;
    base64: string;
}

const base64ToCanvas = (base64: string, targetWidth: number, targetHeight: number): Promise<HTMLCanvasElement> => {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = targetWidth;
            canvas.height = targetHeight;
            const ctx = canvas.getContext('2d');
            if (!ctx) return reject("Failed to get 2d context");

            // Draw the image onto the canvas, scaling to fit the target dimensions
            ctx.drawImage(img, 0, 0, targetWidth, targetHeight);
            resolve(canvas);
        };
        img.onerror = () => reject("Failed to load image from base64");
        // Handle bare base64 or complete data URI
        img.src = base64.startsWith('data:') ? base64 : `data:image/png;base64,${base64}`;
    });
};

const getCanvasDimensions = (base64: string): Promise<{ width: number; height: number }> => {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            resolve({ width: img.naturalWidth, height: img.naturalHeight });
        };
        img.onerror = () => reject("Failed to load image for dimensions");
        img.src = base64.startsWith('data:') ? base64 : `data:image/png;base64,${base64}`;
    });
};


export const createMultiLayerPsdBlob = async (layers: PsdLayerParams[], textNodes?: TextNode[]): Promise<Blob> => {
    if (layers.length === 0) {
        throw new Error("No layers provided to generate PSD.");
    }

    try {
        // Determine the base canvas size from the first valid AI result layer (usually the topmost one is processed)
        // or just the very first layer in the list.
        const dimensions = await getCanvasDimensions(layers[0].base64);
        const { width, height } = dimensions;

        // Create PSD JSON Structure for ag-psd
        const psdChildren = [];

        // Reverse list so that the first item (bg) is at the bottom, and last item is at the top.
        // However, ag-psd's `children` array: the first element is the BOTTOM-MOST layer in Photoshop.
        // If the input array `layers` is [bg, original, aiResult],
        // The PSD `children` array should be [bg, original, aiResult] in that exact order to stack correctly from bottom to top.

        for (const layer of layers) {
            const canvas = await base64ToCanvas(layer.base64, width, height);
            psdChildren.push({
                name: layer.name,
                canvas: canvas,
            });
        }

        // Add text nodes as individual PSD text layers on top
        if (textNodes && textNodes.length > 0) {
            for (const tn of textNodes) {
                // ag-psd expects colors as [R, G, B, A] array (0-255) from Hex
                const hex = tn.hexColor.replace('#', '');
                const r = parseInt(hex.substring(0, 2), 16) || 0;
                const g = parseInt(hex.substring(2, 4), 16) || 0;
                const b = parseInt(hex.substring(4, 6), 16) || 0;

                // Some Gemini generations return absolute pixels (e.g., 300) instead of relative factors (0.3).
                // Our optimize logic bounds extraction payload to 1536. 
                // We normalize here to get actual relative factors before mapping to the real image dimension.
                const relativeX = tn.x > 1 ? tn.x / 1536 : tn.x;
                const relativeY = tn.y > 1 ? tn.y / 1536 : tn.y;
                const relativeSize = tn.fontSize > 1 ? tn.fontSize / 1536 : tn.fontSize;

                const actualX = relativeX * width;
                const actualY = relativeY * height;
                const actualFontSize = relativeSize * height;

                psdChildren.push({
                    name: `Text: ${tn.text.substring(0, 15)}`,
                    text: {
                        text: tn.text,
                        transform: [1, 0, 0, 1, actualX, actualY],
                        style: {
                            font: { name: tn.fontFamily },
                            fontSize: actualFontSize,
                            fillColor: [r, g, b, 255]
                        }
                    }
                });
            }
        }

        const psd = {
            width,
            height,
            children: psdChildren,
        };

        // Serialize to ArrayBuffer
        const buffer = writePsd(psd);

        // Convert to Blob
        return new Blob([buffer], { type: 'application/octet-stream' });
    } catch (error) {
        console.error("Error creating PSD blob:", error);
        throw error;
    }
};
