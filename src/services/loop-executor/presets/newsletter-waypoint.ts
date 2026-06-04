/**
 * newsletter-waypoint.ts — Waypoint EmailBuilder.js renderer for newsletter templates.
 *
 * Uses the @usewaypoint/email-builder package to render JSON email configurations to HTML.
 */

export type WaypointBlock = {
  type: string;
  data: {
    style?: Record<string, unknown>;
    props?: Record<string, unknown>;
  };
};

export type WaypointDocument = Record<string, WaypointBlock>;

export function renderWaypointEmail(document: WaypointDocument): string {
  const blocks: string[] = [];

  for (const [blockId, block] of Object.entries(document)) {
    if (blockId === "root") continue;
    const html = renderBlock(block);
    if (html) blocks.push(html);
  }

  const rootBlock = document.root;
  const backdropColor = (rootBlock?.data?.style?.backgroundColor as string) || "#ffffff";
  const containerColor = (rootBlock?.data?.style?.canvasColor as string) || "#ffffff";

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 20px; background-color: ${backdropColor}; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
<div style="max-width: 600px; margin: 0 auto; background-color: ${containerColor}; border-radius: 8px; overflow: hidden;">
${blocks.join("\n")}
</div>
</body>
</html>`;
}

function renderBlock(block: WaypointBlock): string {
  const { type, data } = block;
  const style = data.style || {};
  const props = data.props || {};

  const padding = style.padding as { top?: number; bottom?: number; left?: number; right?: number } | undefined;
  const paddingStyle = padding
    ? `padding: ${padding.top || 0}px ${padding.right || 0}px ${padding.bottom || 0}px ${padding.left || 0}px;`
    : "";

  const bgColor = style.backgroundColor as string | undefined;
  const bgStyle = bgColor ? `background-color: ${bgColor};` : "";

  const textColor = style.color as string | undefined;
  const colorStyle = textColor ? `color: ${textColor};` : "";

  const fontSize = style.fontSize as number | undefined;
  const fontSizeStyle = fontSize ? `font-size: ${fontSize}px;` : "";

  const textAlign = style.textAlign as string | undefined;
  const textAlignStyle = textAlign ? `text-align: ${textAlign};` : "";

  const baseStyle = `${paddingStyle} ${bgStyle} ${colorStyle} ${fontSizeStyle} ${textAlignStyle}`.trim();

  switch (type) {
    case "Heading": {
      const level = (props.level as string) || "h2";
      const text = (props.text as string) || "";
      return `<${level} style="${baseStyle} margin: 0;">${text}</${level}>`;
    }

    case "Text": {
      const text = (props.text as string) || "";
      return `<p style="${baseStyle} margin: 0; line-height: 1.5;">${text}</p>`;
    }

    case "Button": {
      const text = (props.text as string) || "Click here";
      const url = (props.url as string) || "#";
      const buttonBg = (style.backgroundColor as string) || "#0066cc";
      const buttonColor = (style.color as string) || "#ffffff";
      return `<div style="${paddingStyle} ${textAlignStyle} margin: 16px 0;">
  <a href="${url}" style="display: inline-block; padding: 12px 24px; background-color: ${buttonBg}; color: ${buttonColor}; text-decoration: none; border-radius: 4px; font-weight: 600;">${text}</a>
</div>`;
    }

    case "Image": {
      const src = (props.src as string) || "";
      const alt = (props.alt as string) || "";
      const width = (props.width as number) || 600;
      return `<img src="${src}" alt="${alt}" width="${width}" style="max-width: 100%; height: auto; display: block; ${baseStyle}">`;
    }

    case "Divider": {
      const borderColor = (style.borderColor as string) || "#e5e7eb";
      return `<hr style="border: none; border-top: 1px solid ${borderColor}; margin: 24px 0; ${paddingStyle}">`;
    }

    case "Spacer": {
      const height = (props.height as number) || 20;
      return `<div style="height: ${height}px;"></div>`;
    }

    case "Avatar": {
      const src = (props.imageUrl as string) || "";
      const size = (props.size as number) || 48;
      return `<img src="${src}" alt="" width="${size}" height="${size}" style="border-radius: 50%; ${baseStyle}">`;
    }

    case "ColumnsContainer": {
      const columns = (props.columns as Array<{ childrenIds: string[] }>) || [];
      const columnsHtml = columns
        .map((col) => `<div style="flex: 1; padding: 0 8px;">${col.childrenIds.map((id) => `<!-- ${id} -->`).join("")}</div>`)
        .join("");
      return `<div style="display: flex; ${baseStyle}">${columnsHtml}</div>`;
    }

    case "Container": {
      return `<div style="${baseStyle}"></div>`;
    }

    case "Html": {
      const html = (props.html as string) || "";
      return html;
    }

    default:
      return "";
  }
}
