import { mkdir, writeFile } from 'node:fs/promises';
import { crc32 } from 'node:zlib';

const directory = new URL('./', import.meta.url);
await mkdir(directory, { recursive: true });

function pdf(pages) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, index) => `${5 + index * 2} 0 R`).join(' ')}] >>`,
    '<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [4 0 R] >>',
    '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /DW 1000 >>',
  ];
  for (const [index, lines] of pages.entries()) {
    const stream = lines
      .map((line, row) => {
        const hex = Array.from(line)
          .map((character) => {
            const point = character.codePointAt(0);
            if (point > 65535)
              throw new Error('Fixture font supports only BMP characters');
            return point.toString(16).padStart(4, '0');
          })
          .join('');
        return `BT /F1 12 Tf 48 ${760 - row * 24} Td <${hex}> Tj ET`;
      })
      .join('\n');
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${6 + index * 2} 0 R >>`,
    );
    objects.push(
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    );
  }
  let content = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(content));
    content += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(content);
  content += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  content += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('');
  content += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(content);
}

function zip(entries) {
  const files = [];
  const central = [];
  let offset = 0;
  for (const [name, text] of entries) {
    const filename = Buffer.from(name);
    const data = Buffer.from(text);
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(filename.length, 26);
    files.push(local, filename, data);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt32LE(checksum, 16);
    record.writeUInt32LE(data.length, 20);
    record.writeUInt32LE(data.length, 24);
    record.writeUInt16LE(filename.length, 28);
    record.writeUInt32LE(offset, 42);
    central.push(record, filename);
    offset += local.length + filename.length + data.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(Buffer.concat(central).length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...files, ...central, end]);
}

function docx(paragraphs) {
  const escape = (text) =>
    text
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;');
  return zip([
    [
      '[Content_Types].xml',
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ],
    [
      '_rels/.rels',
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    ],
    [
      'word/document.xml',
      `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs.map((text) => `<w:p><w:r><w:t xml:space="preserve">${escape(text)}</w:t></w:r></w:p>`).join('')}<w:sectPr/></w:body></w:document>`,
    ],
  ]);
}

await writeFile(
  new URL('two-pages.pdf', directory),
  pdf([
    [
      '第一页面说明：天气预报有雨，出门请带雨伞。',
      'First page: rainy weather and umbrellas.',
    ],
    [
      '第二页面说明：数据库索引加快查询与文件检索。',
      'Second page: database indexes and file search.',
    ],
  ]),
);
await writeFile(new URL('empty.pdf', directory), pdf([[]]));
await writeFile(
  new URL('paragraphs.docx', directory),
  docx([
    '第一段：天气预报有雨，出门请带雨伞。',
    '第二段：数据库索引加快查询与文件检索。',
    'Unicode content: 😀 & <original> text.',
  ]),
);
await writeFile(new URL('empty.docx', directory), docx(['']));
console.log('Generated four synthetic PDF/DOCX parser fixtures.');
