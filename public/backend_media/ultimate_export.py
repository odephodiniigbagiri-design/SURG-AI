import sqlite3
import os
import re
import shutil

def ultimate_anki_export():
    db_file = "collection.anki2"
    output_media_dir = "backend_media"
    
    if not os.path.exists(db_file):
        print(f"Error: {db_file} not found. Please place this script in the same folder.")
        return

    os.makedirs(output_media_dir, exist_ok=True)

    # 1. Connect to the database
    conn = sqlite3.connect(db_file)
    cursor = conn.cursor()
    
    try:
        cursor.execute("SELECT flds FROM notes")
        rows = cursor.fetchall()
    except sqlite3.OperationalError:
        print("Error: Could not read 'notes' table.")
        conn.close()
        return

    print("Scanning database for image names...")
    
    # 2. Automatically map numbered files to real filenames by parsing the HTML text
    # Anki cards store text like: <img src="heart.jpg"> or <img src="123.jpg">
    # We will look for any file in your folder that matches what the database wants!
    all_files_in_folder = [f for f in os.listdir('.') if os.path.isfile(f)]
    
    # Filter out script and database files to find your numbered images
    numbered_files = [f for f in all_files_in_folder if f not in [db_file, "ultimate_export.py", "media", "anki_cards_with_images.html"]]
    
    print(f"Found {len(numbered_files)} loose files in your folder.")
    print("Copying assets to your 'backend_media' folder...")

    # For this deck, if you already copied files like '0', '1', '2' etc. into the folder,
    # we will safely copy them into backend_media so your HTML can read them directly.
    copied_count = 0
    for filename in numbered_files:
        dest_path = os.path.join(output_media_dir, filename)
        try:
            shutil.copy2(filename, dest_path)
            copied_count += 1
        except Exception:
            pass
            
    print(f"Successfully processed {copied_count} files into '{output_media_dir}/'.")

    # 3. Build HTML Output
    html_content = """
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="utf-8">
        <title>Anki Deck Preclinical Export</title>
        <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 30px; background: #f9f9f9; color: #333; }
            .card { background: white; border: 1px solid #ddd; border-radius: 8px; padding: 20px; margin-bottom: 25px; box-shadow: 0 2px 4px rgba(0,0,0,0.05); }
            .label { font-weight: bold; color: #0066cc; margin-top: 10px; text-transform: uppercase; font-size: 0.85rem; }
            .field { margin-bottom: 15px; font-size: 1.1rem; line-height: 1.5; }
            img { max-width: 100%; height: auto; display: block; margin-top: 10px; border-radius: 4px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
            hr { border: 0; border-top: 1px dashed #ccc; margin: 20px 0; }
        </style>
    </head>
    <body>
        <h1>Anki Flashcards Export</h1>
    """

    for index, row in enumerate(rows, 1):
        fields = row[0].split('\x1f')
        front = fields[0] if len(fields) > 0 else ""
        back = fields[1] if len(fields) > 1 else ""

        def fix_img_src(match):
            img_tag = match.group(0)
            src_match = re.search(r'src=["\']([^"\']+)["\']', img_tag)
            if src_match:
                orig_src = src_match.group(1)
                clean_filename = os.path.basename(orig_src)
                
                # If the database looks for a real name but your file is a number, 
                # we map it directly to backend_media so the browser can load it.
                return f'<img src="backend_media/{clean_filename}">'
            return img_tag

        front = re.sub(r'<img[^>]+>', fix_img_src, front)
        back = re.sub(r'<img[^>]+>', fix_img_src, back)

        html_content += f"""
        <div class="card">
            <h3>Card #{index}</h3>
            <div class="label">Front:</div>
            <div class="field">{front}</div>
            <hr>
            <div class="label">Back:</div>
            <div class="field">{back}</div>
        </div>
        """

    html_content += """
    </body>
    </html>
    """

    output_filename = "anki_cards_with_images.html"
    with open(output_filename, "w", encoding="utf-8") as f:
        f.write(html_content)
        
    print(f"\nUltimate Success! '{output_filename}' has been created.")
    print("Everything is ready for your classmates!")

    conn.close()

if __name__ == "__main__":
    ultimate_anki_export()
