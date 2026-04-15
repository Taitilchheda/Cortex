import pdfplumber
import re

def extract_features():
    file_path = 'f:\\Cortex\\cortex-features-full.docx.pdf'
    full_text = []
    
    with pdfplumber.open(file_path) as pdf:
        for page in pdf.pages:
            text = page.extract_text(layout=True)
            if text:
                full_text.append(text)
                
    combined_text = '\n'.join(full_text)
    
    # Write the full raw text first to see what it looks like
    with open('f:\\tmp_plumber.txt', 'w', encoding='utf-8') as f:
        f.write(combined_text)

if __name__ == '__main__':
    extract_features()
    print("Done")
