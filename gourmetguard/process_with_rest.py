import os
import json
import base64
import urllib.request
import time

API_KEY = os.environ.get("GEMINI_API_KEY")
API_URL = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key={API_KEY}"

def encode_image(image_path):
    with open(image_path, "rb") as image_file:
        return base64.b64encode(image_file.read()).decode('utf-8')

def generate_prompts(first_image_path, last_image_path):
    try:
        first_b64 = encode_image(first_image_path)
        last_b64 = encode_image(last_image_path)
    except FileNotFoundError:
        print(f"Images not found for {first_image_path} or {last_image_path}")
        return None

    prompt_text = """
    You are a visual video analyzer. You are given the FIRST frame and LAST frame of a short video shot.
    Based on these two images, describe the shot.
    Rules:
    - Use visual descriptions for characters (e.g., 'the security guard', 'the man in the dark jacket') instead of names.
    - The main character is a man in a security uniform (light green/grey shirt, name tag 'DAVIDSON').
    - Another character is a man in a dark jacket.
    - Locations include a grand hallway, a security monitor room, a narrow corridor, etc.
    
    Output strictly valid JSON with no markdown block around it, containing the following keys:
    {
      "composition": "medium_shot", // or wide_establishing, close_up, insert_cutaway, etc.
      "actionPrompt": "A visual description of the motion in the shot.",
      "startFramePrompt": "A detailed visual description of the first frame.",
      "endFramePrompt": "A detailed visual description of the last frame."
    }
    """

    payload = {
        "contents": [
            {
                "parts": [
                    {"text": prompt_text},
                    {"text": "FIRST FRAME:"},
                    {
                        "inlineData": {
                            "mimeType": "image/jpeg",
                            "data": first_b64
                        }
                    },
                    {"text": "LAST FRAME:"},
                    {
                        "inlineData": {
                            "mimeType": "image/jpeg",
                            "data": last_b64
                        }
                    }
                ]
            }
        ],
        "generationConfig": {
            "responseMimeType": "application/json",
            "temperature": 0.2
        }
    }

    req = urllib.request.Request(API_URL, data=json.dumps(payload).encode('utf-8'), headers={'Content-Type': 'application/json'})
    
    max_retries = 3
    for attempt in range(max_retries):
        try:
            with urllib.request.urlopen(req) as response:
                result = json.loads(response.read().decode('utf-8'))
                text_response = result['candidates'][0]['content']['parts'][0]['text']
                return json.loads(text_response)
        except Exception as e:
            print(f"Error calling API (attempt {attempt+1}/{max_retries}): {e}")
            time.sleep(2)
            
    return None

def main():
    json_path = "story_analysis.json"
    with open(json_path, "r") as f:
        data = json.load(f)

    shots = data["scenes"][0]["shots"]
    
    for i in range(6, 58):
        shot_str = f"{i:03d}"
        first_img = f"scene_{shot_str}_first.jpg"
        last_img = f"scene_{shot_str}_last.jpg"
        
        print(f"Processing Scene {i}...")
        prompts = generate_prompts(first_img, last_img)
        
        if prompts:
            # Find the shot in JSON
            for shot in shots:
                if shot["shotNumber"] == i:
                    shot["composition"] = prompts.get("composition", "medium_shot")
                    shot["actionPrompt"] = prompts.get("actionPrompt", "")
                    shot["startFramePrompt"] = prompts.get("startFramePrompt", "")
                    shot["endFramePrompt"] = prompts.get("endFramePrompt", "")
                    break
            
            # Save progressively
            with open(json_path, "w") as f:
                json.dump(data, f, indent=2)
            
            print(f"  Success for Scene {i}")
        else:
            print(f"  Failed for Scene {i}")
            
        time.sleep(1) # Simple rate limiting

if __name__ == "__main__":
    main()
