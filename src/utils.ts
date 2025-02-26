import axios from 'axios';

//** 
// * Function that fetches image from url and return in base64 format. Used for vision models.
// */ 
export async function fetchImageAsBase64(imageUrl: string): Promise<string> {
  
    const response = await axios.get(imageUrl, { responseType: 'blob' });
    const imageBlob = response.data;
    
    // Create a FileReader to read the image as base64
    const base64String = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
            const result = reader.result as string;
            resolve(result.split(',')[1]); // Strip off the data URL prefix (e.g., "data:image/jpeg;base64,")
        };
        reader.onerror = reject;
        reader.readAsDataURL(imageBlob);
    });
  
    return base64String;
}