/** Every pixel holds the selected colour. */
export default {
  id: 'solid',
  name: 'Solid',
  params: ['color'],
  render({ pixelCount, color }) {
    return Array.from({ length: pixelCount }, () => ({ ...color }));
  },
};
