---
name: imagegen
description: Generate a raster image with the built-in image_gen tool when the user asks for an image.
---

# Image generation

Use the built-in `image_gen` tool to generate the requested image. Do not return
HTML, SVG, drawing code, a prompt tutorial, or instructions instead of the image.
This built-in path does not require an `OPENAI_API_KEY`.

When the request names an output path, generate the image first and then copy
the final generated image to that exact path. Create one image, choose reasonable
defaults without asking follow-up questions, and finish only after the file exists.

