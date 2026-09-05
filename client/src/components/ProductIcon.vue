<script setup>
import { computed } from 'vue'
import { productIconMeta } from '../productIcons'

const props = defineProps({
  product: { type: Object, required: true },
  size: { type: String, default: 'md' },
  rounded: { type: String, default: 'xl' },
})

const meta = computed(() => productIconMeta(props.product))

const boxClass = computed(() => ({
  sm: 'h-10 w-10',
  md: 'h-12 w-12',
  lg: 'h-16 w-16',
  xl: 'h-20 w-20',
}[props.size] || 'h-12 w-12'))

const iconClass = computed(() => ({
  sm: 'w-5 h-5',
  md: 'w-6 h-6',
  lg: 'w-8 h-8',
  xl: 'w-10 h-10',
}[props.size] || 'w-6 h-6'))
const roundedClass = computed(() => ({
  lg: 'rounded-lg',
  xl: 'rounded-xl',
  '2xl': 'rounded-2xl',
}[props.rounded] || 'rounded-xl'))
</script>

<template>
  <div
    :class="['flex items-center justify-center text-white shrink-0 shadow-md ring-1 ring-white/20', roundedClass, boxClass]"
    :style="{ background: meta.gradient }"
  >
    <span v-html="meta.svg" :class="iconClass"></span>
  </div>
</template>
