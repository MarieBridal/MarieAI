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

export interface SemanticMasks {
    subject: string;
    background: string;
    skin: string;
}

export const extractMasksFromMap = async (rgbMapB64: string, displayWidth: number, displayHeight: number): Promise<SemanticMasks> => {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => {
            const canvas = document.createElement("canvas");
            canvas.width = displayWidth;
            canvas.height = displayHeight;
            const ctx = canvas.getContext("2d");
            if (!ctx) return reject("Failed to get 2d context");

            ctx.drawImage(img, 0, 0, displayWidth, displayHeight);
            const imgData = ctx.getImageData(0, 0, displayWidth, displayHeight);
            const data = imgData.data;

            const subjectData = new Uint8ClampedArray(data.length);
            const bgData = new Uint8ClampedArray(data.length);
            const skinData = new Uint8ClampedArray(data.length);

            // Function to set pixel to white or black (mask format)
            const setPixel = (targetData: Uint8ClampedArray, i: number, isWhite: boolean) => {
                const val = isWhite ? 255 : 0;
                targetData[i] = val;     // R
                targetData[i + 1] = val; // G
                targetData[i + 2] = val; // B
                targetData[i + 3] = 255; // A
            };

            for (let i = 0; i < data.length; i += 4) {
                const r = data[i];
                const g = data[i + 1];
                const b = data[i + 2];

                // Subject: Red dominant
                const isSubject = r > 100 && r > g * 1.5 && r > b * 1.5;
                // Background: Green dominant
                const isBg = g > 100 && g > r * 1.5 && g > b * 1.5;
                // Skin: Blue dominant
                const isSkin = b > 100 && b > r * 1.5 && b > g * 1.5;

                setPixel(subjectData, i, isSubject);
                setPixel(bgData, i, isBg);
                setPixel(skinData, i, isSkin);
            }

            const subjectCanvas = document.createElement("canvas");
            subjectCanvas.width = displayWidth;
            subjectCanvas.height = displayHeight;
            subjectCanvas.getContext("2d")!.putImageData(new ImageData(subjectData, displayWidth, displayHeight), 0, 0);

            const bgCanvas = document.createElement("canvas");
            bgCanvas.width = displayWidth;
            bgCanvas.height = displayHeight;
            bgCanvas.getContext("2d")!.putImageData(new ImageData(bgData, displayWidth, displayHeight), 0, 0);

            const skinCanvas = document.createElement("canvas");
            skinCanvas.width = displayWidth;
            skinCanvas.height = displayHeight;
            skinCanvas.getContext("2d")!.putImageData(new ImageData(skinData, displayWidth, displayHeight), 0, 0);

            resolve({
                subject: subjectCanvas.toDataURL("image/jpeg", 0.8),
                background: bgCanvas.toDataURL("image/jpeg", 0.8),
                skin: skinCanvas.toDataURL("image/jpeg", 0.8)
            });
        };
        img.onerror = () => reject(new Error("Failed to load rgb map image."));
        img.src = rgbMapB64.startsWith("data:") ? rgbMapB64 : `data:image/png;base64,${rgbMapB64}`;
    });
};
