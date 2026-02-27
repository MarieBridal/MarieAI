export const clipImageWithMask = (
    aiResultB64: string,
    maskB64: string,
    displayWidth: number,
    displayHeight: number
): Promise<string> => {
    return new Promise((resolve, reject) => {
        const aiImg = new Image();
        aiImg.crossOrigin = "anonymous";
        aiImg.onload = () => {
            const maskImg = new Image();
            maskImg.crossOrigin = "anonymous";
            maskImg.onload = () => {
                // Create canvas matching the original display size
                const canvas = document.createElement("canvas");
                canvas.width = displayWidth;
                canvas.height = displayHeight;
                const ctx = canvas.getContext("2d");

                if (!ctx) {
                    return reject(new Error("Failed to get 2d context for clipping."));
                }

                // Draw the full AI result first
                ctx.drawImage(aiImg, 0, 0, displayWidth, displayHeight);

                // Apply masking (destination-in keeps only the pixels where both layers overlap)
                ctx.globalCompositeOperation = "destination-in";
                ctx.drawImage(maskImg, 0, 0, displayWidth, displayHeight);

                // Reset
                ctx.globalCompositeOperation = "source-over";

                // Return base64 png with transparency
                resolve(canvas.toDataURL("image/png"));
            };
            maskImg.onerror = () => reject(new Error("Failed to load mask image."));
            maskImg.src = maskB64.startsWith("data:")
                ? maskB64
                : `data:image/png;base64,${maskB64}`;
        };
        aiImg.onerror = () => reject(new Error("Failed to load AI result image."));
        aiImg.src = aiResultB64.startsWith("data:")
            ? aiResultB64
            : `data:image/png;base64,${aiResultB64}`;
    });
};
