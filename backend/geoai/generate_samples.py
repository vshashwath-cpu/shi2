"""
Generates pre-packaged sample drone images for testing the Drone Image Upload & Area Intelligence feature.
"""

import os
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

def create_sample_drone_images(output_dir="data/samples"):
    os.makedirs(output_dir, exist_ok=True)
    np.random.seed(101)

    # Sample 1: Sector 02 Drone Mission (1024x1024)
    w, h = 1024, 1024
    img1 = Image.new("RGB", (w, h), color=(85, 128, 70)) # Greenish ground base
    draw1 = ImageDraw.Draw(img1)

    # Road network (Dark asphalt corridors)
    draw1.rectangle([0, int(h * 0.46), w, int(h * 0.54)], fill=(55, 58, 62)) # Main horizontal
    draw1.rectangle([int(w * 0.46), 0, int(w * 0.54), h], fill=(55, 58, 62)) # Main cross
    # Lane divider dashes
    for x in range(0, w, 40):
        draw1.line([(x, int(h * 0.5)), (x + 20, int(h * 0.5))], fill=(220, 220, 220), width=3)
    for y in range(0, h, 40):
        draw1.line([(int(w * 0.5), y), (int(w * 0.5), y + 20)], fill=(220, 220, 220), width=3)

    # Paved driveways and pedestrian walkways
    for i in range(4):
        y_pos = int(h * (0.15 + i * 0.22))
        draw1.rectangle([40, y_pos, w - 40, y_pos + 12], fill=(130, 130, 125))

    # Building clusters with varied roof types (terracotta, blue tin, grey concrete flat roofs)
    roof_colors = [(195, 82, 50), (60, 110, 160), (210, 210, 205), (160, 150, 140), (220, 140, 70)]
    for gx in range(4):
        for gy in range(4):
            if gx in (1, 2) and gy in (1, 2):
                continue # Center intersection
            bx = int(60 + gx * 230 + np.random.randint(-15, 15))
            by = int(60 + gy * 230 + np.random.randint(-15, 15))
            bw = int(120 + np.random.randint(-20, 30))
            bh = int(110 + np.random.randint(-20, 30))
            col = roof_colors[(gx + gy) % len(roof_colors)]
            # Draw building with shadow
            draw1.rectangle([bx + 8, by + 8, bx + bw + 8, by + bh + 8], fill=(30, 35, 30))
            draw1.rectangle([bx, by, bx + bw, by + bh], fill=col, outline=(40, 40, 40), width=2)
            # Rooftop HVAC/chimney structures
            draw1.rectangle([bx + 20, by + 20, bx + 45, by + 45], fill=(235, 235, 235))

    # Add tree canopies (irregular green circles)
    for _ in range(60):
        tx = np.random.randint(20, w - 20)
        ty = np.random.randint(20, h - 20)
        tr = np.random.randint(15, 35)
        # Avoid roads
        if not (abs(ty - h * 0.5) < 60 or abs(tx - w * 0.5) < 60):
            t_col = (np.random.randint(30, 65), np.random.randint(110, 160), np.random.randint(30, 70))
            draw1.ellipse([tx - tr, ty - tr, tx + tr, ty + tr], fill=t_col)

    # Texture noise
    arr1 = np.array(img1).astype(np.float32)
    noise = np.random.normal(0, 7.0, arr1.shape)
    arr1 = np.clip(arr1 + noise, 0, 255).astype(np.uint8)
    sample1_path = os.path.join(output_dir, "sample_drone_sector02.jpg")
    Image.fromarray(arr1).save(sample1_path, quality=92)

    # Sample 2: Commercial & Logistics Park Drone Mission (1024x1024)
    img2 = Image.new("RGB", (w, h), color=(140, 135, 120)) # Dry soil/commercial yard
    draw2 = ImageDraw.Draw(img2)

    # Concrete apron / parking lots
    draw2.rectangle([80, 80, w - 80, h - 80], fill=(175, 175, 170))
    # Dual carriageway
    draw2.rectangle([0, int(h * 0.42), w, int(h * 0.58)], fill=(45, 48, 52))
    for x in range(0, w, 50):
        draw2.line([(x, int(h * 0.5)), (x + 25, int(h * 0.5))], fill=(240, 210, 60), width=4)

    # Large industrial / commercial warehouses
    warehouses = [
        (100, 100, 360, 260, (230, 235, 240)), # White warehouse
        (540, 100, 380, 270, (80, 120, 170)),  # Blue logistics hub
        (100, 630, 370, 280, (200, 195, 185)), # Light grey terminal
        (550, 640, 370, 270, (180, 95, 60))    # Terracotta distribution
    ]
    for wx, wy, ww, wh, wcol in warehouses:
        draw2.rectangle([wx + 10, wy + 10, wx + ww + 10, wy + wh + 10], fill=(25, 25, 25))
        draw2.rectangle([wx, wy, wx + ww, wy + wh], fill=wcol, outline=(50, 50, 50), width=3)
        # Solar panels / skylights
        for sx in range(wx + 30, wx + ww - 30, 45):
            for sy in range(wy + 25, wy + wh - 25, 40):
                draw2.rectangle([sx, sy, sx + 30, sy + 25], fill=(30, 40, 75))

    arr2 = np.array(img2).astype(np.float32)
    noise2 = np.random.normal(0, 6.0, arr2.shape)
    arr2 = np.clip(arr2 + noise2, 0, 255).astype(np.uint8)
    sample2_path = os.path.join(output_dir, "sample_drone_commercial.jpg")
    Image.fromarray(arr2).save(sample2_path, quality=92)

    print(f"Generated samples: {sample1_path} and {sample2_path}")

if __name__ == "__main__":
    create_sample_drone_images()
