import PyPDF2
def read_pdf(file_path):
    with open(file_path, 'rb') as file:
        reader = PyPDF2.PdfReader(file)
        text = ''
        for page in reader.pages:
            text += page.extract_text() + '\n'
        return text

if __name__ == '__main__':
    text = read_pdf('f:\\Cortex\\cortex-features-full.docx.pdf')
    with open('f:\\Cortex\\pdf_text.txt', 'w', encoding='utf-8') as out:
        out.write(text)
    print("Done extracting PDF to f:\\Cortex\\pdf_text.txt")
