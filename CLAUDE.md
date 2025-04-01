# Page Image Saver - Development Guidelines

## Build Commands
- `npm run package` - Create a distribution zip file in dist/ folder

## Extension Loading/Testing
- Open Chrome: navigate to `chrome://extensions/`
- Enable "Developer mode" (top right) 
- Click "Load unpacked" and select extension directory
- Test with included `test-page.html` file

## Code Style Guidelines
- **Formatting**: Use consistent indentation (2 spaces) and clear formatting
- **Comments**: Include comments for functions and complex logic sections
- **Naming**: Use camelCase for variables/functions, descriptive names
- **File Organization**: Separate concerns (background.js, content_script.js, etc.)
- **Error Handling**: Use try/catch blocks with specific error messages

## JavaScript Conventions
- Use modern ES6+ features (arrow functions, async/await, template literals)
- Import modules dynamically when needed (via import() for extension modules)
- Favor const over let when variables won't be reassigned
- Use JSDoc-style comments for function documentation

## Chrome Extension Best Practices
- Maintain clear separation between background, content, and UI scripts
- Use Chrome storage for persisting user settings
- Implement proper message passing between extension components
- Follow Chrome Manifest V3 requirements
- Use event listeners for extension lifecycle events