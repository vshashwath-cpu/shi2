"""
GeoAI Cadastral Workstation - Server Launcher
Starts the Flask server on http://127.0.0.1:5000 with environment verification.
"""

import sys
import os
import webbrowser

# Ensure current directory is in sys.path
sys.path.insert(0, os.path.abspath(os.path.dirname(__file__)))

from backend.dataset_generator import generate_urban_dataset
from backend.app import app

def main():
    data_dir = "data"
    print("=" * 75)
    print("   AI-BASED AUTOMATED URBAN PARCEL MAPPING & CADASTRAL FEATURE EXTRACTION   ")
    print("                     Web-GIS Cadastral Workstation                           ")
    print("=" * 75)

    # Check if sample datasets exist
    if not os.path.exists(os.path.join(data_dir, "dataset_metadata.json")):
        print("[Setup] Generating high-resolution urban drone datasets (ORI, DSM, DTM, GT)...")
        generate_urban_dataset(data_dir)
        print("[Setup] Datasets generated successfully.")
    else:
        print("[Setup] High-resolution urban drone datasets loaded from 'data/' directory.")

    port = 5000
    url = f"http://127.0.0.1:{port}"
    print(f"\n[System Online] Web-GIS Workstation listening at: {url}")
    print("  -> Access the interactive Cadastral Workstation in your web browser.")
    print("  -> Press CTRL+C to terminate the server.\n")

    app.run(host="127.0.0.1", port=port, debug=False)

if __name__ == "__main__":
    main()
